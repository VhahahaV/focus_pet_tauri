use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};

const INBOX_FILE: &str = "agent-events.jsonl";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCompletionEvent {
    pub id: String,
    pub provider: String,
    pub status: String,
    pub title: String,
    pub message: String,
    pub occurred_at: String,
}

pub fn maybe_ingest_from_process_args() -> bool {
    let arguments = env::args().collect::<Vec<_>>();
    let Some(flag_index) = arguments
        .iter()
        .position(|argument| argument == "--agent-notify")
    else {
        return false;
    };
    let provider_hint = arguments.get(flag_index + 1).map(String::as_str);
    let inline_payload = arguments
        .iter()
        .skip(flag_index + 1)
        .find(|argument| argument.trim_start().starts_with('{'))
        .cloned();
    let payload_text = inline_payload.unwrap_or_else(|| {
        let mut input = String::new();
        let _ = std::io::stdin().read_to_string(&mut input);
        input
    });

    match ingest_payload(provider_hint, &payload_text) {
        Ok(event) => {
            eprintln!("Focus Pet received {} event {}", event.provider, event.id);
            true
        }
        Err(error) => {
            eprintln!("Focus Pet agent notification failed: {error}");
            true
        }
    }
}

pub fn ingest_payload(
    provider_hint: Option<&str>,
    payload_text: &str,
) -> Result<AgentCompletionEvent, String> {
    let payload = serde_json::from_str::<Value>(payload_text.trim())
        .unwrap_or_else(|_| serde_json::json!({ "message": payload_text.trim() }));
    let provider = detect_provider(provider_hint, &payload);
    let status = detect_status(&payload);
    let provider_title = match provider.as_str() {
        "claude" => "Claude Code",
        "codex" => "Codex",
        value => value,
    };
    let subject = first_text(
        &payload,
        &[
            "task_subject",
            "taskSubject",
            "task_description",
            "taskDescription",
            "last-assistant-message",
            "last_assistant_message",
            "message",
            "summary",
        ],
    )
    .unwrap_or_else(|| "后台任务已结束".to_string());
    let message = if status == "failed" {
        format!(
            "{provider_title} 任务未成功：{}",
            compact_text(&subject, 160)
        )
    } else {
        format!("{provider_title} 已完成：{}", compact_text(&subject, 160))
    };
    let event = AgentCompletionEvent {
        id: format!(
            "agent-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_micros()
        ),
        provider,
        status: status.to_string(),
        title: if status == "failed" {
            "任务执行失败"
        } else {
            "任务已完成"
        }
        .to_string(),
        message,
        occurred_at: chrono::Utc::now().to_rfc3339(),
    };
    append_event(&event)?;
    Ok(event)
}

pub fn drain_events() -> Result<Vec<AgentCompletionEvent>, String> {
    let mut events = drain_events_from_root(&app_data_root())?;
    #[cfg(target_os = "windows")]
    if let Some(legacy_root) = legacy_windows_app_data_root() {
        if legacy_root != app_data_root() {
            events.extend(drain_events_from_root(&legacy_root)?);
        }
    }
    events.sort_by(|left, right| left.occurred_at.cmp(&right.occurred_at));
    Ok(events)
}

fn drain_events_from_root(root: &PathBuf) -> Result<Vec<AgentCompletionEvent>, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let inbox = root.join(INBOX_FILE);
    if !inbox.exists() {
        return Ok(Vec::new());
    }
    let processing = root.join(format!(
        "agent-events-{}-{}.processing",
        std::process::id(),
        chrono::Utc::now().timestamp_micros()
    ));
    fs::rename(&inbox, &processing).map_err(|error| error.to_string())?;
    let text = fs::read_to_string(&processing).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&processing);
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<AgentCompletionEvent>(line).ok())
        .collect())
}

pub fn inbox_path() -> String {
    app_data_root()
        .join(INBOX_FILE)
        .to_string_lossy()
        .to_string()
}

fn append_event(event: &AgentCompletionEvent) -> Result<(), String> {
    let root = app_data_root();
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join(INBOX_FILE))
        .map_err(|error| error.to_string())?;
    let line = serde_json::to_string(event).map_err(|error| error.to_string())?;
    writeln!(file, "{line}").map_err(|error| error.to_string())
}

fn detect_provider(provider_hint: Option<&str>, payload: &Value) -> String {
    let hint = provider_hint.unwrap_or_default().trim().to_lowercase();
    if hint.contains("claude") || payload.get("hook_event_name").is_some() {
        "claude".to_string()
    } else if hint.contains("codex")
        || payload.get("turn-id").is_some()
        || payload.get("turn_id").is_some()
    {
        "codex".to_string()
    } else if hint.is_empty() {
        "agent".to_string()
    } else {
        compact_text(&hint, 32)
    }
}

fn detect_status(payload: &Value) -> &'static str {
    let event_name = first_text(
        payload,
        &["hook_event_name", "hookEventName", "status", "type"],
    )
    .unwrap_or_default()
    .to_lowercase();
    if event_name.contains("fail") || event_name.contains("error") {
        "failed"
    } else {
        "completed"
    }
}

fn first_text(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn compact_text(value: &str, limit: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= limit {
        return normalized;
    }
    let mut compact = normalized
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    compact.push('…');
    compact
}

fn app_data_root() -> PathBuf {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    {
        home.join("Library/Application Support/Focus Pet")
    }
    #[cfg(target_os = "windows")]
    {
        crate::store::windows_focus_pet_data_root()
            .unwrap_or_else(|| home.join("AppData/Local/Focus Pet Data"))
    }
    #[cfg(target_os = "linux")]
    {
        env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("Focus Pet")
    }
}

#[cfg(target_os = "windows")]
fn legacy_windows_app_data_root() -> Option<PathBuf> {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("Focus Pet"))
}

#[cfg(test)]
mod tests {
    use super::{compact_text, detect_provider, detect_status};
    use serde_json::json;

    #[test]
    fn recognizes_codex_and_claude_completion_payloads() {
        let codex = json!({ "type": "agent-turn-complete", "turn-id": "abc" });
        assert_eq!(detect_provider(None, &codex), "codex");
        assert_eq!(detect_status(&codex), "completed");

        let claude = json!({ "hook_event_name": "StopFailure" });
        assert_eq!(detect_provider(None, &claude), "claude");
        assert_eq!(detect_status(&claude), "failed");
        assert_eq!(compact_text("a  b\n c", 16), "a b c");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_agent_inbox_uses_the_stable_local_data_root() {
        let root = super::app_data_root();
        assert!(root.ends_with("Focus Pet Data"));
        assert_eq!(
            super::inbox_path(),
            root.join(super::INBOX_FILE).to_string_lossy().to_string()
        );
        if let Some(legacy) = super::legacy_windows_app_data_root() {
            assert_ne!(root, legacy);
        }
    }
}
