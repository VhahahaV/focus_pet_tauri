use crate::{native, store::FocusPetStore};
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
const CLASSIFICATION_CATALOG: &str = include_str!("../../public/AppClassificationCatalog.json");

#[derive(Clone)]
pub struct NativeRuntimeService {
    inner: Arc<Mutex<RuntimeInner>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeEnvelope {
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<Value>,
    pub current_snapshot: ActivitySnapshot,
    pub current_decision: StateDecision,
    pub latest_nudge: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub timestamp: String,
    pub app_name: String,
    #[serde(rename = "bundleID")]
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub title_stored: bool,
    pub title_display: Option<String>,
    pub category: String,
    pub classification_source: String,
    pub idle_seconds: f64,
    pub switch_count_last5_min: u64,
    pub switch_count_last15_min: u64,
    pub active_category_duration: f64,
    pub active_app_duration: f64,
    pub is_focus_session_active: bool,
    pub is_system_sleeping: bool,
    pub is_screen_locked: bool,
    pub source: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDecision {
    pub timestamp: String,
    pub state: String,
    pub category: String,
    pub confidence: f64,
    pub reason: Vec<String>,
    pub stable_duration: f64,
}

#[derive(Clone, Debug)]
struct RuntimeMemory {
    previous_state: String,
    candidate_state: String,
    candidate_since: DateTime<Utc>,
    stable_state_since: DateTime<Utc>,
    last_tick_at: Option<DateTime<Utc>>,
    active_category: Option<String>,
    active_category_since: DateTime<Utc>,
    active_app: Option<String>,
    active_app_since: DateTime<Utc>,
    sleep_started_at: Option<DateTime<Utc>>,
}

struct RuntimeInner {
    snapshot: Value,
    current_snapshot: ActivitySnapshot,
    current_decision: StateDecision,
    memory: RuntimeMemory,
    generation: u64,
    id_sequence: u64,
    rules: Vec<ClassificationRule>,
    latest_nudge: Option<Value>,
}

#[derive(Clone, Debug)]
struct ClassificationRule {
    match_kind: String,
    pattern: String,
    category: String,
    priority: i64,
    is_user: bool,
}

#[derive(Clone, Copy)]
struct Thresholds {
    ui_stability_seconds: f64,
    idle_distracted_seconds: f64,
    idle_away_seconds: f64,
    distracted_seconds: f64,
}

#[derive(Clone, Debug)]
struct FocusCompletion {
    task_name: String,
}

#[derive(Clone, Debug)]
struct NudgeCandidate {
    reason: &'static str,
    pet_intent: &'static str,
    message: &'static str,
    cooldown_seconds: u64,
}

impl NativeRuntimeService {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let mut snapshot = FocusPetStore::new(app)
            .map_err(|error| error.to_string())?
            .load_snapshot()
            .map_err(|error| error.to_string())?;
        normalize_snapshot_shape(&mut snapshot);
        let now = Utc::now();
        let previous_state = snapshot
            .get("stateSegments")
            .and_then(Value::as_array)
            .and_then(|items| items.last())
            .and_then(|item| item.get("state"))
            .and_then(Value::as_str)
            .filter(|state| matches!(*state, "focus" | "distracted" | "away"))
            .unwrap_or("focus")
            .to_string();
        let stable_state_since = snapshot
            .get("stateSegments")
            .and_then(Value::as_array)
            .and_then(|items| items.last())
            .and_then(|item| item.get("start"))
            .and_then(Value::as_str)
            .and_then(parse_time)
            .unwrap_or(now);
        let current_snapshot = placeholder_activity(now);
        let current_decision = StateDecision {
            timestamp: iso(now),
            state: previous_state.clone(),
            category: "work".to_string(),
            confidence: 0.55,
            reason: vec!["neutralDefault".to_string()],
            stable_duration: seconds_between(stable_state_since, now),
        };
        let rules = classification_rules(&snapshot);
        Ok(Self {
            inner: Arc::new(Mutex::new(RuntimeInner {
                snapshot,
                current_snapshot,
                current_decision,
                memory: RuntimeMemory {
                    previous_state: previous_state.clone(),
                    candidate_state: previous_state,
                    candidate_since: now,
                    stable_state_since,
                    last_tick_at: None,
                    active_category: None,
                    active_category_since: now,
                    active_app: None,
                    active_app_since: now,
                    sleep_started_at: None,
                },
                generation: 0,
                id_sequence: 0,
                rules,
                latest_nudge: None,
            })),
        })
    }

    pub fn start(&self, app: AppHandle) {
        let service = self.clone();
        std::thread::Builder::new()
            .name("focus-pet-runtime".to_string())
            .spawn(move || loop {
                if let Err(error) = service.tick(&app) {
                    log::error!("native runtime tick failed: {error}");
                }
                std::thread::sleep(SAMPLE_INTERVAL);
            })
            .expect("native runtime service thread must start");
    }

    pub fn envelope(&self) -> NativeRuntimeEnvelope {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.envelope()
    }

    pub fn snapshot(&self) -> Value {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.snapshot.clone()
    }

    pub fn persist_snapshot(&self, app: &AppHandle, mut snapshot: Value) -> Result<(), String> {
        normalize_snapshot_shape(&mut snapshot);
        let store = FocusPetStore::new(app).map_err(|error| error.to_string())?;
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        merge_client_snapshot(&inner.snapshot, &mut snapshot);
        inner.rules = classification_rules(&snapshot);
        inner.snapshot = snapshot;
        inner.generation = inner.generation.saturating_add(1);
        store
            .save_snapshot(&inner.snapshot)
            .map_err(|error| error.to_string())
    }

    pub fn set_classification_rules(&self, app: &AppHandle, rules: Value) -> Result<bool, String> {
        if !rules.is_array() {
            return Err("classification rules must be an array".to_string());
        }
        let store = FocusPetStore::new(app).map_err(|error| error.to_string())?;
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Persist the tiny rules document before publishing it to the resident
        // classifier. This keeps the click path independent from the months of
        // history in the main snapshot and leaves memory unchanged on failure.
        // Holding the runtime lock also serializes this write with the five-
        // second full snapshot, so an older rules array cannot win the race.
        store
            .save_classification_rules(&rules)
            .map_err(|error| error.to_string())?;
        inner.snapshot["classificationRules"] = rules;
        inner.rules = classification_rules(&inner.snapshot);
        inner.generation = inner.generation.saturating_add(1);
        Ok(true)
    }

    fn tick(&self, app: &AppHandle) -> Result<(), String> {
        let sample = native::sample_activity();
        let store = FocusPetStore::new(app).map_err(|error| error.to_string())?;
        let envelope = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.advance(sample);
            store
                .save_snapshot(&inner.snapshot)
                .map_err(|error| error.to_string())?;
            inner.event_envelope()
        };
        app.emit("focus-pet-native-runtime", &envelope)
            .map_err(|error| error.to_string())
    }

    pub fn refresh_now(&self, app: &AppHandle) -> Result<(), String> {
        self.tick(app)
    }

    pub fn handle_system_sleep(&self, app: &AppHandle) -> Result<(), String> {
        let now = Utc::now();
        let store = FocusPetStore::new(app).map_err(|error| error.to_string())?;
        let envelope = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.memory.sleep_started_at.get_or_insert(now);
            let mut activity = placeholder_activity(now);
            activity.app_name = "Sleep".to_string();
            activity.bundle_id = None;
            activity.category = "ignore".to_string();
            activity.is_system_sleeping = true;
            activity.source = vec!["systemSleep".to_string()];
            let native_thresholds = thresholds(&inner.snapshot);
            let raw = evaluate_state(
                &activity,
                Some(inner.memory.previous_state.as_str()),
                native_thresholds,
            );
            let decision = stabilize(raw, &mut inner.memory, native_thresholds, now);
            inner.current_snapshot = activity;
            inner.current_decision = decision;
            inner.generation = inner.generation.saturating_add(1);
            store
                .save_snapshot(&inner.snapshot)
                .map_err(|error| error.to_string())?;
            inner.event_envelope()
        };
        app.emit("focus-pet-native-runtime", &envelope)
            .map_err(|error| error.to_string())
    }

    pub fn handle_system_wake(&self, app: &AppHandle) -> Result<(), String> {
        self.tick(app)
    }
}

impl RuntimeInner {
    fn envelope(&self) -> NativeRuntimeEnvelope {
        NativeRuntimeEnvelope {
            generation: self.generation,
            snapshot: Some(self.snapshot.clone()),
            delta: None,
            current_snapshot: self.current_snapshot.clone(),
            current_decision: self.current_decision.clone(),
            latest_nudge: self
                .latest_nudge
                .as_ref()
                .filter(|event| nudge_is_recent(event, Utc::now()))
                .cloned(),
        }
    }

    fn event_envelope(&self) -> NativeRuntimeEnvelope {
        NativeRuntimeEnvelope {
            generation: self.generation,
            snapshot: None,
            delta: Some(runtime_delta(&self.snapshot)),
            current_snapshot: self.current_snapshot.clone(),
            current_decision: self.current_decision.clone(),
            latest_nudge: self
                .latest_nudge
                .as_ref()
                .filter(|event| nudge_is_recent(event, Utc::now()))
                .cloned(),
        }
    }

    fn advance(&mut self, sample: native::NativeActivitySample) {
        let now = parse_time(&sample.timestamp).unwrap_or_else(Utc::now);
        let raw_tick_seconds = self
            .memory
            .last_tick_at
            .map(|last| seconds_between(last, now).max(1.0))
            .unwrap_or(SAMPLE_INTERVAL.as_secs_f64());
        let thresholds = thresholds(&self.snapshot);
        let forced_sleep_seconds = if !sample.is_system_sleeping {
            self.memory
                .sleep_started_at
                .take()
                .map(|start| seconds_between(start, now))
                .unwrap_or(0.0)
        } else {
            0.0
        };
        let live_tick_seconds = if forced_sleep_seconds > 0.0 {
            0.0
        } else {
            raw_tick_seconds.min(60.0)
        };
        let sleep_like_gap = raw_tick_seconds >= 65.0
            && (sample.is_system_sleeping
                || sample.is_screen_locked
                || sample.idle_seconds >= raw_tick_seconds - 60.0);
        let long_gap = raw_tick_seconds
            >= number(
                self.snapshot
                    .pointer("/settings/judgment")
                    .unwrap_or(&Value::Null),
                "idleAwaySeconds",
                600.0,
            )
            .max(30.0 * 60.0);
        let backfilled_away_seconds = if forced_sleep_seconds > 0.0 {
            forced_sleep_seconds
        } else if self.memory.last_tick_at.is_some() && (sleep_like_gap || long_gap) {
            (raw_tick_seconds - live_tick_seconds).max(0.0)
        } else {
            0.0
        };
        let previous_state_before_tick = if backfilled_away_seconds > 0.0 {
            "away".to_string()
        } else {
            self.memory.previous_state.clone()
        };
        let previous_state_duration = if backfilled_away_seconds > 0.0 {
            backfilled_away_seconds
        } else {
            seconds_between(self.memory.stable_state_since, now)
        };

        let active_focus = active_session(&self.snapshot, "focusSessions").is_some();
        let (category, classification_source) = classify(&self.rules, &sample);
        let app_key = format!(
            "{}|{}",
            sample.bundle_id.as_deref().unwrap_or_default(),
            sample.app_name
        );
        if self.memory.active_category.as_deref() != Some(category.as_str()) {
            self.memory.active_category = Some(category.clone());
            self.memory.active_category_since = now;
        }
        if self.memory.active_app.as_deref() != Some(app_key.as_str()) {
            self.memory.active_app = Some(app_key);
            self.memory.active_app_since = now;
        }
        let switch_count_last5_min =
            switch_count_in_window(&self.snapshot, now, 5 * 60).max(sample.switch_count as u64);
        let switch_count_last15_min =
            switch_count_in_window(&self.snapshot, now, 15 * 60).max(sample.switch_count as u64);
        let title = sample
            .window_title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut source = vec![
            "frontmostApplication".to_string(),
            "windowTitle".to_string(),
            "idleTime".to_string(),
            "appSwitching".to_string(),
        ];
        if active_focus {
            source.push("focusSession".to_string());
        }
        if sample.is_system_sleeping {
            source.push("systemSleep".to_string());
        }
        if sample.is_screen_locked {
            source.push("screenLock".to_string());
        }
        let activity = ActivitySnapshot {
            timestamp: iso(now),
            app_name: nonempty(&sample.app_name).unwrap_or("Unknown").to_string(),
            bundle_id: sample
                .bundle_id
                .clone()
                .filter(|value| !value.trim().is_empty()),
            window_title: None,
            title_stored: false,
            title_display: title.map(redacted_title),
            category: category.clone(),
            classification_source,
            idle_seconds: sample.idle_seconds.max(0.0),
            switch_count_last5_min,
            switch_count_last15_min,
            active_category_duration: seconds_between(self.memory.active_category_since, now),
            active_app_duration: seconds_between(self.memory.active_app_since, now),
            is_focus_session_active: active_focus,
            is_system_sleeping: sample.is_system_sleeping,
            is_screen_locked: sample.is_screen_locked,
            source,
        };
        let raw = evaluate_state(
            &activity,
            Some(self.memory.previous_state.as_str()),
            thresholds,
        );
        let decision = stabilize(raw, &mut self.memory, thresholds, now);
        self.memory.last_tick_at = Some(now);

        if backfilled_away_seconds > 0.0 {
            let away_end = now - ChronoDuration::milliseconds((live_tick_seconds * 1000.0) as i64);
            let source = if forced_sleep_seconds > 0.0
                || sample.is_system_sleeping
                || (sleep_like_gap && !sample.is_screen_locked)
            {
                "systemSleep"
            } else if sample.is_screen_locked {
                "screenLock"
            } else {
                "idleTime"
            };
            self.record_away_interval(
                away_end - ChronoDuration::milliseconds((backfilled_away_seconds * 1000.0) as i64),
                away_end,
                source,
            );
        }
        self.record_state_segment(&decision, &activity, live_tick_seconds);
        if decision.state != "away" {
            self.record_app_usage(&activity, live_tick_seconds);
        }
        self.record_input(
            now,
            sample.keyboard_count as u64,
            sample.pointer_count as u64,
            sample.switch_count as u64,
        );
        if let Some(completed) = account_focus_session(
            &mut self.snapshot,
            &decision,
            &activity,
            live_tick_seconds,
            backfilled_away_seconds,
            sample.switch_count as u64,
            &previous_state_before_tick,
            now,
        ) {
            self.record_nudge(
                now,
                "focusSessionCompleted",
                "focus",
                &completed.task_name,
                "work",
                "focusDone",
                "专注任务已完成",
                0,
            );
        }
        if let Some(nudge) = evaluate_nudge(
            &self.snapshot,
            &decision,
            &activity,
            &previous_state_before_tick,
            previous_state_duration,
            now,
        ) {
            self.record_nudge(
                now,
                nudge.reason,
                &decision.state,
                &activity.app_name,
                &activity.category,
                nudge.pet_intent,
                nudge.message,
                nudge.cooldown_seconds,
            );
        }
        self.current_snapshot = activity;
        self.current_decision = decision;
        self.generation = self.generation.saturating_add(1);
    }

    fn record_away_interval(&mut self, start: DateTime<Utc>, end: DateTime<Utc>, source: &str) {
        if end <= start {
            return;
        }
        let activity = ActivitySnapshot {
            timestamp: iso(end),
            app_name: if source == "systemSleep" {
                "Sleep".to_string()
            } else if source == "screenLock" {
                "Locked Screen".to_string()
            } else {
                "Away".to_string()
            },
            bundle_id: None,
            window_title: None,
            title_stored: false,
            title_display: None,
            category: "ignore".to_string(),
            classification_source: "unmatched".to_string(),
            idle_seconds: seconds_between(start, end),
            switch_count_last5_min: 0,
            switch_count_last15_min: 0,
            active_category_duration: seconds_between(start, end),
            active_app_duration: 0.0,
            is_focus_session_active: active_session(&self.snapshot, "focusSessions").is_some(),
            is_system_sleeping: source == "systemSleep",
            is_screen_locked: source == "screenLock",
            source: vec![source.to_string()],
        };
        let decision = StateDecision {
            timestamp: iso(end),
            state: "away".to_string(),
            category: "ignore".to_string(),
            confidence: 0.98,
            reason: vec![if source == "systemSleep" {
                "systemSleep".to_string()
            } else if source == "screenLock" {
                "screenLocked".to_string()
            } else {
                "longInputIdleAway".to_string()
            }],
            stable_duration: seconds_between(start, end),
        };
        self.record_state_segment(&decision, &activity, seconds_between(start, end));
    }

    #[allow(clippy::too_many_arguments)]
    fn record_nudge(
        &mut self,
        now: DateTime<Utc>,
        reason: &str,
        state: &str,
        app_name: &str,
        category: &str,
        pet_intent: &str,
        message: &str,
        cooldown_seconds: u64,
    ) {
        if !reminder_allows(&self.snapshot, reason, now) {
            return;
        }
        let event = json!({
            "id": self.next_id("nudge", now),
            "time": iso(now),
            "reason": reason,
            "state": state,
            "appName": app_name,
            "category": category,
            "petIntent": pet_intent,
            "channel": "desktop",
            "cooldownSeconds": cooldown_seconds,
            "message": message
        });
        self.push_nudge(event);
    }

    fn push_nudge(&mut self, event: Value) {
        array_mut(&mut self.snapshot, "nudges").push(event.clone());
        self.latest_nudge = Some(event);
    }

    fn next_id(&mut self, prefix: &str, now: DateTime<Utc>) -> String {
        self.id_sequence = self.id_sequence.saturating_add(1);
        format!("{prefix}-{}-{}", now.timestamp_millis(), self.id_sequence)
    }

    fn record_state_segment(
        &mut self,
        decision: &StateDecision,
        activity: &ActivitySnapshot,
        tick_seconds: f64,
    ) {
        let now = parse_time(&activity.timestamp).unwrap_or_else(Utc::now);
        let id = self.next_id("state-segment", now);
        let items = array_mut(&mut self.snapshot, "stateSegments");
        if let Some(last) = items.last_mut() {
            let same = last.get("state").and_then(Value::as_str) == Some(decision.state.as_str())
                && last.get("category").and_then(Value::as_str) == Some(decision.category.as_str())
                && last.get("appName").and_then(Value::as_str) == Some(activity.app_name.as_str())
                && last.get("bundleID")
                    == activity
                        .bundle_id
                        .as_ref()
                        .map(|value| json!(value))
                        .as_ref();
            let gap = last
                .get("end")
                .and_then(Value::as_str)
                .and_then(parse_time)
                .map(|end| seconds_between(end, now))
                .unwrap_or(f64::MAX);
            if same && gap <= 15.0 {
                if let Some(object) = last.as_object_mut() {
                    object.insert("end".to_string(), json!(activity.timestamp));
                }
                return;
            }
        }
        let proposed_start = now - ChronoDuration::milliseconds((tick_seconds * 1000.0) as i64);
        let previous_end = items
            .last()
            .and_then(|item| item.get("end"))
            .and_then(Value::as_str)
            .and_then(parse_time)
            .unwrap_or(proposed_start);
        let start = proposed_start.max(previous_end);
        if now <= start {
            return;
        }
        items.push(json!({
            "id": id,
            "start": iso(start),
            "end": activity.timestamp,
            "state": decision.state,
            "appName": activity.app_name,
            "bundleID": activity.bundle_id,
            "category": activity.category,
            "titleStored": activity.title_stored,
            "titleDisplay": activity.title_display,
            "source": activity.source
        }));
    }

    fn record_app_usage(&mut self, activity: &ActivitySnapshot, tick_seconds: f64) {
        let now = parse_time(&activity.timestamp).unwrap_or_else(Utc::now);
        let id = self.next_id("app-usage", now);
        let items = array_mut(&mut self.snapshot, "appUsage");
        if let Some(last) = items.last_mut() {
            let same = last.get("category").and_then(Value::as_str)
                == Some(activity.category.as_str())
                && last.get("appName").and_then(Value::as_str) == Some(activity.app_name.as_str())
                && last.get("bundleID")
                    == activity
                        .bundle_id
                        .as_ref()
                        .map(|value| json!(value))
                        .as_ref();
            let gap = last
                .get("end")
                .and_then(Value::as_str)
                .and_then(parse_time)
                .map(|end| seconds_between(end, now))
                .unwrap_or(f64::MAX);
            if same && gap <= 15.0 {
                if let Some(object) = last.as_object_mut() {
                    object.insert("end".to_string(), json!(activity.timestamp));
                }
                return;
            }
        }
        let proposed_start = now - ChronoDuration::milliseconds((tick_seconds * 1000.0) as i64);
        let previous_end = items
            .last()
            .and_then(|item| item.get("end"))
            .and_then(Value::as_str)
            .and_then(parse_time)
            .unwrap_or(proposed_start);
        let start = proposed_start.max(previous_end);
        if now <= start {
            return;
        }
        items.push(json!({
            "id": id,
            "start": iso(start),
            "end": activity.timestamp,
            "appName": activity.app_name,
            "bundleID": activity.bundle_id,
            "category": activity.category
        }));
    }

    fn record_input(
        &mut self,
        now: DateTime<Utc>,
        keyboard_count: u64,
        pointer_count: u64,
        switch_count: u64,
    ) {
        if keyboard_count == 0 && pointer_count == 0 && switch_count == 0 {
            return;
        }
        let seconds = now.timestamp();
        let start_seconds = seconds - seconds.rem_euclid(60);
        let start = DateTime::from_timestamp(start_seconds, 0).unwrap_or(now);
        let end = start + ChronoDuration::minutes(1);
        let start_iso = iso(start);
        let end_iso = iso(end);
        let items = array_mut(&mut self.snapshot, "inputActivity");
        if let Some(current) = items.iter_mut().find(|item| {
            item.get("start").and_then(Value::as_str) == Some(start_iso.as_str())
                && item.get("end").and_then(Value::as_str) == Some(end_iso.as_str())
        }) {
            add_u64(current, "keyboardCount", keyboard_count);
            add_u64(current, "pointerCount", pointer_count);
            add_u64(current, "switchCount", switch_count);
            return;
        }
        items.push(json!({
            "start": start_iso,
            "end": end_iso,
            "keyboardCount": keyboard_count,
            "pointerCount": pointer_count,
            "switchCount": switch_count
        }));
    }
}

fn normalize_snapshot_shape(snapshot: &mut Value) {
    if !snapshot.is_object() {
        *snapshot = json!({});
    }
    let object = snapshot.as_object_mut().expect("snapshot is object");
    object
        .entry("settings".to_string())
        .or_insert_with(|| json!({}));
    for key in [
        "classificationRules",
        "stateSegments",
        "appUsage",
        "inputActivity",
        "focusSessions",
        "breakSessions",
        "nudges",
    ] {
        let value = object.entry(key.to_string()).or_insert_with(|| json!([]));
        if !value.is_array() {
            *value = json!([]);
        }
    }
}

/// The WebView edits settings and starts/stops sessions, while the resident
/// service continuously advances activity history and session counters. A
/// delayed WebView save must therefore be merged, never treated as an
/// authoritative replacement of the service's newer snapshot.
fn merge_client_snapshot(current: &Value, incoming: &mut Value) {
    merge_array_by_key(current, incoming, "stateSegments", item_id, merge_segment);
    merge_array_by_key(current, incoming, "appUsage", item_id, merge_segment);
    merge_array_by_key(
        current,
        incoming,
        "inputActivity",
        input_bucket_key,
        merge_input_bucket,
    );
    merge_array_by_key(
        current,
        incoming,
        "focusSessions",
        session_key,
        merge_session,
    );
    merge_array_by_key(
        current,
        incoming,
        "breakSessions",
        session_key,
        merge_session,
    );
    merge_array_by_key(current, incoming, "nudges", item_id, merge_existing_native);
}

fn merge_array_by_key(
    current: &Value,
    incoming: &mut Value,
    field: &str,
    key: fn(&Value) -> Option<String>,
    merge: fn(&Value, &mut Value),
) {
    let Some(current_items) = current.get(field).and_then(Value::as_array) else {
        return;
    };
    let incoming_items = array_mut(incoming, field);
    for current_item in current_items {
        let Some(current_key) = key(current_item) else {
            if !incoming_items.contains(current_item) {
                incoming_items.push(current_item.clone());
            }
            continue;
        };
        if let Some(client_item) = incoming_items
            .iter_mut()
            .find(|item| key(item).as_deref() == Some(current_key.as_str()))
        {
            merge(current_item, client_item);
        } else {
            incoming_items.push(current_item.clone());
        }
    }
    incoming_items.sort_by(|left, right| temporal_key(left).cmp(temporal_key(right)));
}

fn item_id(item: &Value) -> Option<String> {
    item.get("id").and_then(Value::as_str).map(str::to_string)
}

fn session_key(item: &Value) -> Option<String> {
    item_id(item).or_else(|| {
        item.get("start")
            .and_then(Value::as_str)
            .map(|start| format!("start:{start}"))
    })
}

fn input_bucket_key(item: &Value) -> Option<String> {
    Some(format!(
        "{}|{}",
        item.get("start").and_then(Value::as_str)?,
        item.get("end").and_then(Value::as_str)?
    ))
}

fn temporal_key(item: &Value) -> &str {
    item.get("start")
        .or_else(|| item.get("time"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn merge_segment(current: &Value, incoming: &mut Value) {
    let current_end = current.get("end").and_then(Value::as_str);
    let incoming_end = incoming.get("end").and_then(Value::as_str);
    if current_end > incoming_end {
        if let (Some(end), Some(object)) = (current.get("end"), incoming.as_object_mut()) {
            object.insert("end".to_string(), end.clone());
        }
    }
}

fn merge_input_bucket(current: &Value, incoming: &mut Value) {
    for field in ["keyboardCount", "pointerCount", "switchCount"] {
        let current_count = current.get(field).and_then(Value::as_u64).unwrap_or(0);
        let incoming_count = incoming.get(field).and_then(Value::as_u64).unwrap_or(0);
        if current_count > incoming_count {
            if let Some(object) = incoming.as_object_mut() {
                object.insert(field.to_string(), json!(current_count));
            }
        }
    }
}

fn merge_session(current: &Value, incoming: &mut Value) {
    for field in [
        "effectiveFocusSeconds",
        "distractedSeconds",
        "awaySeconds",
        "switchCount",
        "interruptionCount",
    ] {
        let current_count = current.get(field).and_then(Value::as_u64).unwrap_or(0);
        let incoming_count = incoming.get(field).and_then(Value::as_u64).unwrap_or(0);
        if current_count > incoming_count {
            if let Some(object) = incoming.as_object_mut() {
                object.insert(field.to_string(), json!(current_count));
            }
        }
    }

    let native_completed = current
        .get("completed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || matches!(
            current.get("status").and_then(Value::as_str),
            Some("completed")
        );
    let client_has_end = incoming.get("end").is_some_and(|value| !value.is_null());
    if native_completed || !client_has_end {
        for field in ["end", "status", "completed"] {
            if let Some(value) = current.get(field) {
                if let Some(object) = incoming.as_object_mut() {
                    object.insert(field.to_string(), value.clone());
                }
            }
        }
    }
}

fn merge_existing_native(current: &Value, incoming: &mut Value) {
    *incoming = current.clone();
}

fn array_mut<'a>(snapshot: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    snapshot
        .as_object_mut()
        .expect("normalized snapshot")
        .entry(key.to_string())
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .expect("normalized snapshot array")
}

/// Runtime events only need the records touched by the latest five-second
/// sample. Sending the complete retained history through WebView IPC made
/// every UI update progressively more expensive as months accumulated.
fn runtime_delta(snapshot: &Value) -> Value {
    let mut delta = serde_json::Map::new();
    for key in [
        "stateSegments",
        "appUsage",
        "inputActivity",
        "focusSessions",
        "breakSessions",
        "nudges",
    ] {
        if let Some(items) = snapshot.get(key).and_then(Value::as_array) {
            let recent = items
                .iter()
                .rev()
                .take(3)
                .rev()
                .cloned()
                .collect::<Vec<_>>();
            if !recent.is_empty() {
                delta.insert(key.to_string(), Value::Array(recent));
            }
        }
    }
    Value::Object(delta)
}

fn placeholder_activity(now: DateTime<Utc>) -> ActivitySnapshot {
    ActivitySnapshot {
        timestamp: iso(now),
        app_name: "Focus Pet".to_string(),
        bundle_id: Some("com.focuspet.FocusPet".to_string()),
        window_title: None,
        title_stored: false,
        title_display: None,
        category: "work".to_string(),
        classification_source: "fallbackRule".to_string(),
        idle_seconds: 0.0,
        switch_count_last5_min: 0,
        switch_count_last15_min: 0,
        active_category_duration: 0.0,
        active_app_duration: 0.0,
        is_focus_session_active: false,
        is_system_sleeping: false,
        is_screen_locked: false,
        source: vec!["frontmostApplication".to_string()],
    }
}

fn classification_rules(snapshot: &Value) -> Vec<ClassificationRule> {
    let mut rules = Vec::new();
    if let Some(user_rules) = snapshot
        .get("classificationRules")
        .and_then(Value::as_array)
    {
        for (offset, rule) in user_rules.iter().enumerate() {
            if let Some(parsed) = parse_rule(rule, Some(10_000_i64.saturating_sub(offset as i64))) {
                rules.push(parsed);
            }
        }
    }
    if let Ok(entries) = serde_json::from_str::<Value>(CLASSIFICATION_CATALOG) {
        if let Some(entries) = entries.as_array() {
            for entry in entries {
                let match_kind = entry
                    .get("matchKind")
                    .and_then(Value::as_str)
                    .unwrap_or("appName");
                let category = entry
                    .get("category")
                    .and_then(Value::as_str)
                    .unwrap_or("ignore");
                let priority = entry.get("priority").and_then(Value::as_i64).unwrap_or(0);
                if let Some(patterns) = entry.get("patterns").and_then(Value::as_array) {
                    for pattern in patterns.iter().filter_map(Value::as_str) {
                        if !pattern.trim().is_empty() {
                            rules.push(ClassificationRule {
                                match_kind: match_kind.to_string(),
                                pattern: pattern.trim().to_lowercase(),
                                category: category.to_string(),
                                priority,
                                is_user: false,
                            });
                        }
                    }
                }
            }
        }
    }
    rules.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.pattern.cmp(&right.pattern))
    });
    rules
}

fn parse_rule(rule: &Value, elevated_priority: Option<i64>) -> Option<ClassificationRule> {
    let pattern = rule.get("pattern")?.as_str()?.trim();
    if pattern.is_empty() {
        return None;
    }
    let priority = rule.get("priority").and_then(Value::as_i64).unwrap_or(0);
    Some(ClassificationRule {
        match_kind: rule
            .get("matchKind")
            .and_then(Value::as_str)
            .unwrap_or("appName")
            .to_string(),
        pattern: pattern.to_lowercase(),
        category: rule
            .get("category")
            .and_then(Value::as_str)
            .unwrap_or("ignore")
            .to_string(),
        priority: elevated_priority.map_or(priority, |value| value.max(priority)),
        is_user: elevated_priority.is_some(),
    })
}

fn classify(
    rules: &[ClassificationRule],
    sample: &native::NativeActivitySample,
) -> (String, String) {
    let app_name = sample.app_name.to_lowercase();
    let bundle_id = sample
        .bundle_id
        .as_deref()
        .unwrap_or_default()
        .to_lowercase();
    let window_title = sample
        .window_title
        .as_deref()
        .unwrap_or_default()
        .to_lowercase();
    rules
        .iter()
        .find(|rule| {
            let haystack = match rule.match_kind.as_str() {
                "bundleID" => bundle_id.as_str(),
                "windowTitle" => window_title.as_str(),
                _ => app_name.as_str(),
            };
            haystack.contains(&rule.pattern)
        })
        .map(|rule| {
            (
                rule.category.clone(),
                if rule.is_user {
                    "userRule"
                } else {
                    "catalogRule"
                }
                .to_string(),
            )
        })
        .unwrap_or_else(|| ("ignore".to_string(), "unmatched".to_string()))
}

fn thresholds(snapshot: &Value) -> Thresholds {
    let judgment = snapshot
        .pointer("/settings/judgment")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let idle_distracted = number(&judgment, "inputIdleDistractedSeconds", 180.0).clamp(30.0, 900.0);
    Thresholds {
        ui_stability_seconds: number(&judgment, "focusRecoverySeconds", 10.0).clamp(1.0, 120.0),
        idle_distracted_seconds: idle_distracted,
        idle_away_seconds: number(&judgment, "idleAwaySeconds", 600.0)
            .max(idle_distracted)
            .clamp(180.0, 3600.0),
        distracted_seconds: number(&judgment, "entertainmentDistractedSeconds", 60.0)
            .clamp(15.0, 900.0),
    }
}

fn number(value: &Value, key: &str, fallback: f64) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(fallback)
}

fn evaluate_state(
    snapshot: &ActivitySnapshot,
    previous: Option<&str>,
    thresholds: Thresholds,
) -> StateDecision {
    let carry = if previous == Some("distracted") {
        "distracted"
    } else {
        "focus"
    };
    let decision =
        |state: &str, confidence: f64, reasons: &[&str], stable_duration: f64| StateDecision {
            timestamp: snapshot.timestamp.clone(),
            state: state.to_string(),
            category: snapshot.category.clone(),
            confidence,
            reason: reasons.iter().map(|value| (*value).to_string()).collect(),
            stable_duration: stable_duration.max(0.0),
        };
    if snapshot.is_system_sleeping {
        return decision(
            "away",
            0.98,
            &["systemSleep"],
            snapshot.idle_seconds.max(snapshot.active_category_duration),
        );
    }
    if snapshot.is_screen_locked {
        return decision(
            "away",
            0.96,
            &["screenLocked"],
            snapshot.idle_seconds.max(snapshot.active_category_duration),
        );
    }
    if snapshot.idle_seconds >= thresholds.idle_away_seconds {
        return decision("away", 0.88, &["longInputIdleAway"], snapshot.idle_seconds);
    }
    if snapshot.idle_seconds >= thresholds.idle_distracted_seconds {
        return decision(
            "distracted",
            0.82,
            &["inputIdleDistracted"],
            snapshot.idle_seconds,
        );
    }
    match snapshot.category.as_str() {
        "work" => decision(
            "focus",
            0.84,
            &["workCategory"],
            snapshot.active_category_duration,
        ),
        "entertainment" if snapshot.classification_source == "userRule" => decision(
            "distracted",
            0.96,
            &["explicitEntertainmentRule"],
            snapshot.active_category_duration,
        ),
        "entertainment" if snapshot.active_category_duration >= thresholds.distracted_seconds => {
            decision(
                "distracted",
                0.84,
                &["entertainmentStable"],
                snapshot.active_category_duration,
            )
        }
        "entertainment" => decision(
            carry,
            0.58,
            &["entertainmentGrace", "previousStateHeld"],
            snapshot.active_category_duration,
        ),
        "ignore" => decision(
            carry,
            0.45,
            &["ignoredActivity", "previousStateHeld"],
            snapshot.active_category_duration,
        ),
        _ if previous == Some("distracted")
            && snapshot.idle_seconds <= thresholds.ui_stability_seconds =>
        {
            decision(
                "focus",
                0.64,
                &["recentInputRecovery"],
                snapshot.active_category_duration,
            )
        }
        _ => decision(
            carry,
            0.55,
            if previous.is_none() {
                &["neutralDefault"]
            } else {
                &["previousStateHeld"]
            },
            snapshot.active_category_duration,
        ),
    }
}

fn stabilize(
    mut decision: StateDecision,
    memory: &mut RuntimeMemory,
    thresholds: Thresholds,
    now: DateTime<Utc>,
) -> StateDecision {
    let immediate = (memory.previous_state == "distracted" && decision.state == "focus")
        || decision.reason.iter().any(|reason| {
            matches!(
                reason.as_str(),
                "recentInputRecovery"
                    | "explicitEntertainmentRule"
                    | "inputIdleDistracted"
                    | "systemSleep"
                    | "screenLocked"
                    | "longInputIdleAway"
                    | "activeBreak"
            )
        })
        || (memory.previous_state == "break" && decision.state != "break");
    if immediate {
        if decision.state != memory.previous_state {
            memory.previous_state = decision.state.clone();
        }
        memory.candidate_state = decision.state.clone();
        memory.candidate_since = now;
        memory.stable_state_since =
            now - ChronoDuration::milliseconds((decision.stable_duration * 1000.0) as i64);
        return decision;
    }
    if decision.state != memory.candidate_state {
        memory.candidate_state = decision.state.clone();
        memory.candidate_since = now;
    }
    if decision.state == memory.previous_state {
        decision.stable_duration = seconds_between(memory.stable_state_since, now);
        return decision;
    }
    if seconds_between(memory.candidate_since, now) >= thresholds.ui_stability_seconds {
        memory.previous_state = decision.state.clone();
        memory.stable_state_since = memory.candidate_since;
        decision.stable_duration = seconds_between(memory.stable_state_since, now);
        return decision;
    }
    decision.state = memory.previous_state.clone();
    decision.confidence = (decision.confidence - 0.2).max(0.4);
    decision.reason = vec!["previousStateHeld".to_string()];
    decision.stable_duration = seconds_between(memory.stable_state_since, now);
    decision
}

fn active_session<'a>(snapshot: &'a Value, key: &str) -> Option<&'a Value> {
    snapshot
        .get(key)
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .rev()
                .find(|item| item.get("end").map_or(true, Value::is_null))
        })
}

#[allow(clippy::too_many_arguments)]
fn account_focus_session(
    snapshot: &mut Value,
    decision: &StateDecision,
    activity: &ActivitySnapshot,
    tick_seconds: f64,
    backfilled_away_seconds: f64,
    switch_count: u64,
    previous_state: &str,
    now: DateTime<Utc>,
) -> Option<FocusCompletion> {
    let items = array_mut(snapshot, "focusSessions");
    let active = items.iter_mut().rev().find(|item| {
        item.get("status").and_then(Value::as_str) == Some("active")
            && item.get("end").map_or(true, Value::is_null)
    })?;
    add_u64(
        active,
        "awaySeconds",
        backfilled_away_seconds.round() as u64,
    );
    let classified_for_attention = matches!(activity.category.as_str(), "work" | "entertainment");
    match (classified_for_attention, decision.state.as_str()) {
        (true, "focus") => add_u64(active, "effectiveFocusSeconds", tick_seconds.round() as u64),
        (true, "distracted") => add_u64(active, "distractedSeconds", tick_seconds.round() as u64),
        (_, "away") => add_u64(active, "awaySeconds", tick_seconds.round() as u64),
        _ => {}
    }
    add_u64(active, "switchCount", switch_count);
    if classified_for_attention && decision.state == "distracted" && previous_state != "distracted"
    {
        add_u64(active, "interruptionCount", 1);
    }
    if active
        .get("mainAppName")
        .and_then(Value::as_str)
        .map_or(true, str::is_empty)
        && activity.category == "work"
    {
        if let Some(object) = active.as_object_mut() {
            object.insert("mainAppName".to_string(), json!(activity.app_name));
        }
    }
    let start = active
        .get("start")
        .and_then(Value::as_str)
        .and_then(parse_time);
    let target = active
        .get("targetDurationSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(25 * 60)
        .max(60);
    if start.is_some_and(|start| seconds_between(start, now) >= target as f64) {
        let completion = FocusCompletion {
            task_name: active
                .get("taskName")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("专注任务")
                .to_string(),
        };
        if let Some(object) = active.as_object_mut() {
            object.insert("end".to_string(), json!(iso(now)));
            object.insert("status".to_string(), json!("completed"));
            object.insert("completed".to_string(), json!(true));
        }
        return Some(completion);
    }
    None
}

fn evaluate_nudge(
    snapshot: &Value,
    decision: &StateDecision,
    activity: &ActivitySnapshot,
    previous_state: &str,
    previous_state_duration: f64,
    now: DateTime<Utc>,
) -> Option<NudgeCandidate> {
    let reminder = snapshot
        .pointer("/settings/reminder")
        .unwrap_or(&Value::Null);
    let cooldown = (number(reminder, "cooldownMinutes", 10.0).max(1.0) * 60.0).round() as u64;
    let candidate = if previous_state == "away"
        && decision.state == "focus"
        && previous_state_duration >= 30.0 * 60.0
    {
        NudgeCandidate {
            reason: "welcomeBack",
            pet_intent: "welcomeBack",
            message: "继续当前任务",
            cooldown_seconds: cooldown.max(2 * 60 * 60),
        }
    } else {
        match decision.state.as_str() {
            "distracted"
                if decision.stable_duration
                    >= number(reminder, "strongDistractedMinutes", 12.0).max(1.0) * 60.0 =>
            {
                NudgeCandidate {
                    reason: "distractedStrong",
                    pet_intent: "nudgeStrong",
                    message: "立即回到任务",
                    cooldown_seconds: cooldown,
                }
            }
            "distracted"
                if decision.stable_duration
                    >= number(reminder, "lightDistractedMinutes", 5.0).max(1.0) * 60.0 =>
            {
                NudgeCandidate {
                    reason: "distractedOverThreshold",
                    pet_intent: "nudgeGentle",
                    message: "回到任务 2 分钟",
                    cooldown_seconds: cooldown,
                }
            }
            _ => return None,
        }
    };
    if !reminder_allows(snapshot, candidate.reason, now)
        || nudge_on_cooldown(snapshot, candidate.reason, candidate.cooldown_seconds, now)
    {
        return None;
    }
    let _ = activity;
    Some(candidate)
}

fn reminder_allows(snapshot: &Value, reason: &str, now: DateTime<Utc>) -> bool {
    let reminder = snapshot
        .pointer("/settings/reminder")
        .unwrap_or(&Value::Null);
    if reminder
        .get("pauseUntil")
        .and_then(Value::as_str)
        .and_then(parse_time)
        .is_some_and(|pause_until| pause_until > now)
    {
        return false;
    }
    let flag = match reason {
        "distractedOverThreshold" | "distractedStrong" | "frequentSwitching" => {
            "enableDistractedNudges"
        }
        "focusSessionCompleted" => return true,
        "longFocusRest" | "veryLongFocusRest" | "breakEnding" => return false,
        "welcomeBack" => "enableWelcomeBackNudges",
        _ => return true,
    };
    reminder.get(flag).and_then(Value::as_bool).unwrap_or(true)
}

fn nudge_on_cooldown(
    snapshot: &Value,
    reason: &str,
    cooldown_seconds: u64,
    now: DateTime<Utc>,
) -> bool {
    if cooldown_seconds == 0 {
        return false;
    }
    let group: &[&str] = match reason {
        "distractedOverThreshold" | "distractedStrong" | "frequentSwitching" => &[
            "distractedOverThreshold",
            "distractedStrong",
            "frequentSwitching",
        ],
        "focusSessionCompleted" => &["focusSessionCompleted"],
        "welcomeBack" => &["welcomeBack"],
        _ => &[reason],
    };
    snapshot
        .get("nudges")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .filter(|event| {
            event
                .get("reason")
                .and_then(Value::as_str)
                .is_some_and(|value| group.contains(&value))
        })
        .filter_map(|event| {
            event
                .get("time")
                .and_then(Value::as_str)
                .and_then(parse_time)
        })
        .any(|time| seconds_between(time, now) < cooldown_seconds as f64)
}

fn nudge_is_recent(event: &Value, now: DateTime<Utc>) -> bool {
    event
        .get("time")
        .and_then(Value::as_str)
        .and_then(parse_time)
        .is_some_and(|time| seconds_between(time, now) <= 30.0)
}

fn switch_count_in_window(snapshot: &Value, now: DateTime<Utc>, seconds: i64) -> u64 {
    let cutoff = now - ChronoDuration::seconds(seconds);
    snapshot
        .get("inputActivity")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|bucket| {
            bucket
                .get("end")
                .and_then(Value::as_str)
                .and_then(parse_time)
                .is_some_and(|end| end > cutoff)
        })
        .filter_map(|bucket| bucket.get("switchCount").and_then(Value::as_u64))
        .sum()
}

fn add_u64(value: &mut Value, key: &str, amount: u64) {
    if amount == 0 {
        return;
    }
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let current = object.get(key).and_then(Value::as_u64).unwrap_or(0);
    object.insert(key.to_string(), json!(current.saturating_add(amount)));
}

fn nonempty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn redacted_title(title: &str) -> String {
    let mut result = String::new();
    let mut in_word = false;
    for character in title.trim().chars().take(28) {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '%' | '+' | '-') {
            if !in_word {
                result.push('•');
            }
            in_word = true;
        } else {
            in_word = false;
            result.push(character);
        }
    }
    result
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn seconds_between(start: DateTime<Utc>, end: DateTime<Utc>) -> f64 {
    (end - start).num_milliseconds().max(0) as f64 / 1000.0
}

#[cfg(test)]
mod tests {
    use super::{
        account_focus_session, classification_rules, evaluate_nudge, evaluate_state,
        merge_client_snapshot, normalize_snapshot_shape, parse_time, placeholder_activity,
        ActivitySnapshot, RuntimeInner, RuntimeMemory, StateDecision, Thresholds,
    };
    use crate::native;
    use serde_json::json;

    fn snapshot(category: &str) -> ActivitySnapshot {
        ActivitySnapshot {
            timestamp: "2026-07-31T00:00:00.000Z".to_string(),
            app_name: "Editor".to_string(),
            bundle_id: Some("com.example.Editor".to_string()),
            window_title: None,
            title_stored: false,
            title_display: None,
            category: category.to_string(),
            classification_source: "catalogRule".to_string(),
            idle_seconds: 0.0,
            switch_count_last5_min: 0,
            switch_count_last15_min: 0,
            active_category_duration: 120.0,
            active_app_duration: 120.0,
            is_focus_session_active: false,
            is_system_sleeping: false,
            is_screen_locked: false,
            source: Vec::new(),
        }
    }

    fn thresholds() -> Thresholds {
        Thresholds {
            ui_stability_seconds: 10.0,
            idle_distracted_seconds: 180.0,
            idle_away_seconds: 600.0,
            distracted_seconds: 60.0,
        }
    }

    #[test]
    fn native_state_engine_matches_sleep_precedence() {
        let mut activity = snapshot("work");
        activity.is_system_sleeping = true;
        assert_eq!(
            evaluate_state(&activity, Some("focus"), thresholds()).state,
            "away"
        );
    }

    #[test]
    fn native_state_engine_matches_entertainment_threshold() {
        let activity = snapshot("entertainment");
        let decision = evaluate_state(&activity, Some("focus"), thresholds());
        assert_eq!(decision.state, "distracted");
        assert_eq!(decision.reason, vec!["entertainmentStable"]);
    }

    #[test]
    fn manual_entertainment_rule_is_immediate_even_before_grace_threshold() {
        let mut activity = snapshot("entertainment");
        activity.classification_source = "userRule".to_string();
        activity.active_category_duration = 0.0;
        let decision = evaluate_state(&activity, Some("focus"), thresholds());
        assert_eq!(decision.state, "distracted");
        assert_eq!(decision.reason, vec!["explicitEntertainmentRule"]);
    }

    #[test]
    fn resident_runtime_applies_manual_wechat_entertainment_rule_while_typing() {
        let now = parse_time("2026-07-31T00:00:05.000Z").unwrap();
        let mut persisted = json!({
            "classificationRules": [{
                "id": "wechat-entertainment",
                "matchKind": "bundleID",
                "pattern": "com.tencent.xinWeChat",
                "category": "entertainment",
                "priority": 0
            }]
        });
        normalize_snapshot_shape(&mut persisted);
        let rules = classification_rules(&persisted);
        let initial_activity = placeholder_activity(now);
        let mut runtime = RuntimeInner {
            snapshot: persisted,
            current_snapshot: initial_activity,
            current_decision: StateDecision {
                timestamp: "2026-07-31T00:00:00.000Z".to_string(),
                state: "focus".to_string(),
                category: "work".to_string(),
                confidence: 0.84,
                reason: vec!["workCategory".to_string()],
                stable_duration: 60.0,
            },
            memory: RuntimeMemory {
                previous_state: "focus".to_string(),
                candidate_state: "focus".to_string(),
                candidate_since: now,
                stable_state_since: now,
                last_tick_at: Some(now - chrono::Duration::seconds(5)),
                active_category: None,
                active_category_since: now,
                active_app: None,
                active_app_since: now,
                sleep_started_at: None,
            },
            generation: 0,
            id_sequence: 0,
            rules,
            latest_nudge: None,
        };

        runtime.advance(native::NativeActivitySample {
            timestamp: "2026-07-31T00:00:05.000Z".to_string(),
            platform: "test".to_string(),
            sample_quality: "exact".to_string(),
            app_name: "微信".to_string(),
            bundle_id: Some("com.tencent.xinWeChat".to_string()),
            window_title: Some("聊天".to_string()),
            idle_seconds: 0.0,
            input_monitoring_status: "available".to_string(),
            keyboard_count: 24,
            pointer_count: 2,
            switch_count: 0,
            is_system_sleeping: false,
            is_screen_locked: false,
        });

        assert_eq!(runtime.current_snapshot.category, "entertainment");
        assert_eq!(runtime.current_snapshot.classification_source, "userRule");
        assert_eq!(runtime.current_decision.state, "distracted");
        assert_eq!(
            runtime.current_decision.reason,
            vec!["explicitEntertainmentRule"]
        );
        assert_eq!(runtime.snapshot["stateSegments"][0]["state"], "distracted");
        assert_eq!(runtime.snapshot["inputActivity"][0]["keyboardCount"], 24);
    }

    #[test]
    fn ignored_app_does_not_advance_effective_focus_session_time() {
        let now = parse_time("2026-07-31T00:01:00.000Z").unwrap();
        let mut persisted = json!({
            "focusSessions": [{
                "id": "focus-ignored",
                "taskName": "Write",
                "start": "2026-07-31T00:00:00.000Z",
                "targetDurationSeconds": 1500,
                "status": "active",
                "effectiveFocusSeconds": 0,
                "distractedSeconds": 0,
                "awaySeconds": 0,
                "interruptionCount": 0,
                "switchCount": 0
            }]
        });
        let activity = snapshot("ignore");
        let decision = StateDecision {
            timestamp: activity.timestamp.clone(),
            state: "focus".to_string(),
            category: "ignore".to_string(),
            confidence: 0.45,
            reason: vec!["ignoredActivity".to_string()],
            stable_duration: 60.0,
        };
        assert!(account_focus_session(
            &mut persisted,
            &decision,
            &activity,
            5.0,
            0.0,
            0,
            "focus",
            now,
        )
        .is_none());
        assert_eq!(persisted["focusSessions"][0]["effectiveFocusSeconds"], 0);
    }

    #[test]
    fn delayed_webview_save_cannot_erase_newer_native_history() {
        let current = json!({
            "settings": {"theme": "system"},
            "classificationRules": [],
            "stateSegments": [{
                "id": "state-1",
                "start": "2026-07-31T00:00:00.000Z",
                "end": "2026-07-31T00:00:10.000Z",
                "state": "focus"
            }],
            "appUsage": [],
            "inputActivity": [{
                "start": "2026-07-31T00:00:00.000Z",
                "end": "2026-07-31T00:01:00.000Z",
                "keyboardCount": 12,
                "pointerCount": 8,
                "switchCount": 2
            }],
            "focusSessions": [{
                "id": "focus-1",
                "start": "2026-07-31T00:00:00.000Z",
                "status": "completed",
                "completed": true,
                "end": "2026-07-31T00:25:00.000Z",
                "effectiveFocusSeconds": 1400
            }],
            "breakSessions": [],
            "nudges": [{"id": "nudge-1", "time": "2026-07-31T00:25:00.000Z"}]
        });
        let mut stale_client = json!({
            "settings": {"theme": "dark"},
            "classificationRules": [],
            "stateSegments": [{
                "id": "state-1",
                "start": "2026-07-31T00:00:00.000Z",
                "end": "2026-07-31T00:00:05.000Z",
                "state": "focus"
            }],
            "appUsage": [],
            "inputActivity": [{
                "start": "2026-07-31T00:00:00.000Z",
                "end": "2026-07-31T00:01:00.000Z",
                "keyboardCount": 4,
                "pointerCount": 2,
                "switchCount": 1
            }],
            "focusSessions": [{
                "id": "focus-1",
                "start": "2026-07-31T00:00:00.000Z",
                "status": "active",
                "effectiveFocusSeconds": 300
            }],
            "breakSessions": [],
            "nudges": []
        });

        merge_client_snapshot(&current, &mut stale_client);

        assert_eq!(stale_client["settings"]["theme"], "dark");
        assert_eq!(
            stale_client["stateSegments"][0]["end"],
            "2026-07-31T00:00:10.000Z"
        );
        assert_eq!(stale_client["inputActivity"][0]["keyboardCount"], 12);
        assert_eq!(stale_client["focusSessions"][0]["status"], "completed");
        assert_eq!(
            stale_client["focusSessions"][0]["effectiveFocusSeconds"],
            1400
        );
        assert_eq!(stale_client["nudges"][0]["id"], "nudge-1");
    }

    #[test]
    fn resident_runtime_completes_focus_without_starting_a_break() {
        let now = parse_time("2026-07-31T00:25:00.000Z").unwrap();
        let mut persisted = json!({
            "focusSessions": [{
                "id": "focus-1",
                "taskName": "Architecture review",
                "start": "2026-07-31T00:00:00.000Z",
                "targetDurationSeconds": 1500,
                "status": "active",
                "effectiveFocusSeconds": 1400,
                "distractedSeconds": 0,
                "awaySeconds": 0,
                "interruptionCount": 0,
                "switchCount": 0
            }]
        });
        let activity = snapshot("work");
        let decision = StateDecision {
            timestamp: activity.timestamp.clone(),
            state: "distracted".to_string(),
            category: "entertainment".to_string(),
            confidence: 0.9,
            reason: vec!["entertainmentStable".to_string()],
            stable_duration: 720.0,
        };
        let completion = account_focus_session(
            &mut persisted,
            &decision,
            &activity,
            5.0,
            120.0,
            3,
            "focus",
            now,
        )
        .expect("session should complete");
        assert_eq!(completion.task_name, "Architecture review");
        let session = &persisted["focusSessions"][0];
        assert_eq!(session["status"], "completed");
        assert_eq!(session["awaySeconds"], 120);
        assert_eq!(session["distractedSeconds"], 5);
        assert_eq!(session["interruptionCount"], 1);
        assert_eq!(session["switchCount"], 3);
    }

    #[test]
    fn resident_nudges_match_swift_threshold_and_cooldown_groups() {
        let now = parse_time("2026-07-31T02:00:00.000Z").unwrap();
        let persisted = json!({
            "settings": {
                "reminder": {
                    "enableDistractedNudges": true,
                    "enableWelcomeBackNudges": true,
                    "lightDistractedMinutes": 5,
                    "strongDistractedMinutes": 12,
                    "cooldownMinutes": 10
                }
            },
            "nudges": [{
                "time": "2026-07-31T01:55:00.000Z",
                "reason": "distractedOverThreshold"
            }]
        });
        let mut activity = snapshot("entertainment");
        activity.app_name = "Video".to_string();
        let distracted = StateDecision {
            timestamp: activity.timestamp.clone(),
            state: "distracted".to_string(),
            category: "entertainment".to_string(),
            confidence: 0.9,
            reason: vec!["entertainmentStable".to_string()],
            stable_duration: 12.0 * 60.0,
        };
        assert!(evaluate_nudge(
            &persisted,
            &distracted,
            &activity,
            "distracted",
            12.0 * 60.0,
            now,
        )
        .is_none());

        let welcome = StateDecision {
            timestamp: activity.timestamp.clone(),
            state: "focus".to_string(),
            category: "work".to_string(),
            confidence: 0.9,
            reason: vec!["workCategory".to_string()],
            stable_duration: 1.0,
        };
        let candidate = evaluate_nudge(&persisted, &welcome, &activity, "away", 31.0 * 60.0, now)
            .expect("welcome-back nudge");
        assert_eq!(candidate.reason, "welcomeBack");
        assert_eq!(candidate.cooldown_seconds, 2 * 60 * 60);
    }
}
