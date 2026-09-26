use chrono::Utc;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const SCHEMA_VERSION: &str = "focuspet-mvp-1";
const DATA_MIGRATION_VERSION: u64 = 2;
const COMPATIBLE_SCHEMA_VERSIONS: &[&str] = &["focuspet-tauri-1"];
const APP_SUPPORT_FOLDER: &str = "Focus Pet";
#[cfg(target_os = "windows")]
const WINDOWS_APP_SUPPORT_FOLDER: &str = "Focus Pet Data";
const LEGACY_APP_SUPPORT_FOLDERS: &[&str] = &["FocusPetMVP", "FocusPetV0", "FocusPetLegacy"];
pub struct FocusPetStore {
    root: PathBuf,
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_focus_pet_data_root() -> Option<PathBuf> {
    windows_local_app_data_dir().map(|directory| directory.join(WINDOWS_APP_SUPPORT_FOLDER))
}

impl FocusPetStore {
    pub fn new(app: &AppHandle) -> io::Result<Self> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| fallback_data_dir());
        #[cfg(target_os = "windows")]
        let root = {
            let tauri_local_root = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| fallback_data_dir());
            let stable_local_data = windows_local_app_data_dir();
            let root = stable_local_data
                .as_ref()
                .map(|directory| directory.join(WINDOWS_APP_SUPPORT_FOLDER))
                .unwrap_or_else(|| tauri_local_root.clone());
            // NSIS current-user installs use `%LOCALAPPDATA%\Focus Pet` as the
            // application directory. Keep user data outside that tree so an
            // uninstall cannot remove history or imported pet packs. Older
            // builds stored data there, so copy only known data entries and
            // never migrate the executable/uninstaller alongside them.
            if let Some(directory) = stable_local_data {
                migrate_store_contents_if_needed(&directory.join(APP_SUPPORT_FOLDER), &root)?;
            }
            let legacy_root = app_data_dir
                .parent()
                .map(|parent| parent.join(APP_SUPPORT_FOLDER))
                .unwrap_or_else(|| app_data_dir.clone());
            migrate_store_root_if_needed(&legacy_root, &root)?;
            migrate_store_root_if_needed(&tauri_local_root, &root)?;
            root
        };
        #[cfg(not(target_os = "windows"))]
        let root = app_data_dir
            .parent()
            .map(|parent| parent.join(APP_SUPPORT_FOLDER))
            .unwrap_or(app_data_dir);
        let store = Self { root };
        store.prepare_store_for_access(false)?;
        Ok(store)
    }

    #[cfg(test)]
    fn from_root(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("Logs")
    }

    pub fn pet_packs_dir(&self) -> PathBuf {
        self.root.join("PetPacks")
    }

    pub fn load_snapshot(&self) -> io::Result<Value> {
        self.prepare_store_for_access(false)?;
        let mut snapshot = json!({
            "settings": self.read_json("settings.json", json!({}))?,
            "classificationRules": self.read_json("classification-rules.json", json!([]))?,
            "stateSegments": self.read_json("state-segments.json", json!([]))?,
            "appUsage": self.read_json("app-usage.json", json!([]))?,
            "inputActivity": self.read_json("input-activity.json", json!([]))?,
            "focusSessions": self.read_json("focus-sessions.json", json!([]))?,
            "breakSessions": self.read_json("break-sessions.json", json!([]))?,
            "nudges": self.read_json("nudges.json", json!([]))?
        });
        if let Some(settings) = snapshot.get_mut("settings").and_then(Value::as_object_mut) {
            settings.remove("codex");
        }
        compact_history(&mut snapshot);
        Ok(snapshot)
    }

    pub fn save_snapshot(&self, snapshot: &Value) -> io::Result<()> {
        self.prepare_store_for_access(true)?;
        self.write_metadata()?;
        self.write_json(
            "settings.json",
            snapshot.get("settings").unwrap_or(&json!({})),
        )?;
        self.write_json(
            "classification-rules.json",
            snapshot.get("classificationRules").unwrap_or(&json!([])),
        )?;
        self.write_json(
            "state-segments.json",
            snapshot.get("stateSegments").unwrap_or(&json!([])),
        )?;
        self.write_json(
            "app-usage.json",
            snapshot.get("appUsage").unwrap_or(&json!([])),
        )?;
        self.write_json(
            "input-activity.json",
            snapshot.get("inputActivity").unwrap_or(&json!([])),
        )?;
        self.write_json(
            "focus-sessions.json",
            snapshot.get("focusSessions").unwrap_or(&json!([])),
        )?;
        self.write_json(
            "break-sessions.json",
            snapshot.get("breakSessions").unwrap_or(&json!([])),
        )?;
        self.write_json("nudges.json", snapshot.get("nudges").unwrap_or(&json!([])))?;
        Ok(())
    }

    pub fn write_input_diagnostics(&self, value: &Value) -> io::Result<()> {
        self.write_json("input-diagnostics.json", value)
    }

    pub fn save_classification_rules(&self, rules: &Value) -> io::Result<()> {
        self.prepare_store_for_access(true)?;
        self.write_metadata()?;
        self.write_json("classification-rules.json", rules)
    }

    fn prepare_store_for_access(&self, write_intent: bool) -> io::Result<bool> {
        self.migrate_legacy_root_if_needed()?;
        self.ensure_root()?;
        match self.metadata_state()? {
            MetadataState::Current => {
                self.migrate_break_data_if_needed()?;
                self.remove_legacy_roots();
                Ok(true)
            }
            MetadataState::Missing => {
                if self.root_contains_data() {
                    self.backup_root_if_needed("missing-schema")?;
                }
                self.migrate_break_data_if_needed()?;
                self.remove_legacy_roots();
                Ok(true)
            }
            MetadataState::Invalid => {
                if self.root_contains_data() {
                    self.backup_root_if_needed("invalid-schema")?;
                }
                if write_intent {
                    Err(io::Error::other(
                        "local store schema is invalid; writes are blocked",
                    ))
                } else {
                    Ok(false)
                }
            }
            MetadataState::Unsupported(version) => {
                if self.root_contains_data() {
                    self.backup_root_if_needed(&format!("unsupported-schema-{version}"))?;
                }
                if write_intent {
                    Err(io::Error::other(format!(
                        "unsupported local store schema {version}; writes are blocked"
                    )))
                } else {
                    Ok(false)
                }
            }
        }
    }

    fn ensure_root(&self) -> io::Result<()> {
        fs::create_dir_all(&self.root)?;
        fs::create_dir_all(self.logs_dir())?;
        fs::create_dir_all(self.pet_packs_dir())?;
        Ok(())
    }

    fn write_metadata(&self) -> io::Result<()> {
        self.write_json(
            "schema.json",
            &json!({
                "schemaVersion": SCHEMA_VERSION,
                "dataMigrationVersion": DATA_MIGRATION_VERSION
            }),
        )
    }

    fn metadata_state(&self) -> io::Result<MetadataState> {
        let path = self.root.join("schema.json");
        if !path.exists() {
            return Ok(MetadataState::Missing);
        }
        let bytes = fs::read(path)?;
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return Ok(MetadataState::Invalid),
        };
        let Some(version) = value.get("schemaVersion").and_then(Value::as_str) else {
            return Ok(MetadataState::Invalid);
        };
        if version == SCHEMA_VERSION || COMPATIBLE_SCHEMA_VERSIONS.contains(&version) {
            Ok(MetadataState::Current)
        } else {
            Ok(MetadataState::Unsupported(version.to_string()))
        }
    }

    fn root_contains_data(&self) -> bool {
        fs::read_dir(&self.root)
            .map(|mut entries| entries.any(|entry| entry.is_ok()))
            .unwrap_or(false)
    }

    fn backup_root_if_needed(&self, reason: &str) -> io::Result<()> {
        if !self.root_contains_data() {
            return Ok(());
        }
        let Some(parent) = self.root.parent() else {
            return Ok(());
        };
        let safe_reason = sanitized_backup_reason(reason);
        let backup_prefix = format!(
            "{} Backup ",
            self.root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(APP_SUPPORT_FOLDER)
        );
        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&backup_prefix) && name.ends_with(&format!(" {safe_reason}")) {
                    return Ok(());
                }
            }
        }
        fs::create_dir_all(parent)?;
        let timestamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let base_name = format!("{backup_prefix}{timestamp} {safe_reason}");
        let mut backup = parent.join(&base_name);
        let mut suffix = 2;
        while backup.exists() {
            backup = parent.join(format!("{base_name}-{suffix}"));
            suffix += 1;
        }
        copy_dir_all(&self.root, &backup)
    }

    fn migrate_legacy_root_if_needed(&self) -> io::Result<()> {
        if self.root.join("schema.json").exists() || self.root_contains_data() {
            return Ok(());
        }
        let Some(parent) = self.root.parent() else {
            return Ok(());
        };
        for legacy_root in legacy_roots(parent, &self.root) {
            if !legacy_root.join("schema.json").exists() {
                continue;
            }
            if self.root.exists() {
                fs::remove_dir_all(&self.root)?;
            }
            fs::create_dir_all(parent)?;
            match fs::rename(&legacy_root, &self.root) {
                Ok(()) => return Ok(()),
                Err(_) => {
                    copy_dir_all(&legacy_root, &self.root)?;
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    fn remove_legacy_roots(&self) {
        let Some(parent) = self.root.parent() else {
            return;
        };
        for legacy_root in legacy_roots(parent, &self.root) {
            if legacy_root.join("schema.json").exists() {
                let _ = fs::remove_dir_all(legacy_root);
            }
        }
    }

    fn migrate_break_data_if_needed(&self) -> io::Result<()> {
        let metadata = self.read_json("schema.json", json!({}))?;
        if metadata
            .get("dataMigrationVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= DATA_MIGRATION_VERSION
        {
            return Ok(());
        }

        if self.root_contains_data() {
            self.backup_root_if_needed("before-break-restoration-v2")?;
        }
        let recovery_roots = self.break_recovery_roots();

        let mut break_sessions = self.read_json("break-sessions.json", json!([]))?;
        let mut state_segments = self.read_json("state-segments.json", json!([]))?;
        let mut nudges = self.read_json("nudges.json", json!([]))?;
        for recovery_root in &recovery_roots {
            merge_json_array_by_id(
                &mut break_sessions,
                &read_json_file(&recovery_root.join("break-sessions.json"), json!([])),
                |_| true,
            );
            merge_json_array_by_id(
                &mut state_segments,
                &read_json_file(&recovery_root.join("state-segments.json"), json!([])),
                |item| item.get("state").and_then(Value::as_str) == Some("break"),
            );
            merge_json_array_by_id(
                &mut nudges,
                &read_json_file(&recovery_root.join("nudges.json"), json!([])),
                |item| {
                    matches!(
                        item.get("reason").and_then(Value::as_str),
                        Some("longFocusRest" | "veryLongFocusRest" | "breakEnding")
                    )
                },
            );
        }

        let mut focus_sessions = self.read_json("focus-sessions.json", json!([]))?;
        let recovered_focus_sessions = recovery_roots
            .iter()
            .map(|root| read_json_file(&root.join("focus-sessions.json"), json!([])))
            .collect::<Vec<_>>();
        restore_focus_break_fields(&mut focus_sessions, &recovered_focus_sessions);

        let mut settings = self.read_json("settings.json", json!({}))?;
        let recovered_settings = recovery_roots
            .iter()
            .map(|root| read_json_file(&root.join("settings.json"), json!({})))
            .collect::<Vec<_>>();
        restore_break_settings(&mut settings, &recovered_settings);

        self.write_json("break-sessions.json", &break_sessions)?;
        self.write_json("state-segments.json", &state_segments)?;
        self.write_json("focus-sessions.json", &focus_sessions)?;
        self.write_json("nudges.json", &nudges)?;
        self.write_json("settings.json", &settings)?;
        self.write_metadata()
    }

    fn break_recovery_roots(&self) -> Vec<PathBuf> {
        let Some(parent) = self.root.parent() else {
            return Vec::new();
        };
        let backup_prefix = format!(
            "{} Backup ",
            self.root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(APP_SUPPORT_FOLDER)
        );
        let mut roots = fs::read_dir(parent)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_dir()
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(&backup_prefix))
                    && path.join("break-sessions.json").is_file()
            })
            .collect::<Vec<_>>();
        roots.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
        roots
    }

    fn read_json(&self, name: &str, default_value: Value) -> io::Result<Value> {
        let path = self.root.join(name);
        if !path.exists() {
            return Ok(default_value);
        }
        let bytes = fs::read(path)?;
        serde_json::from_slice(&bytes).or(Ok(default_value))
    }

    fn write_json(&self, name: &str, value: &Value) -> io::Result<()> {
        let path = self.root.join(name);
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
        if fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) {
            return Ok(());
        }
        fs::write(&temporary, &bytes)?;
        replace_file(&temporary, &path)?;
        Ok(())
    }
}

/// Join contiguous, identical observations without filling gaps or changing
/// categories, titles, sources, or the duration attributed to any application.
pub(crate) fn compact_history(snapshot: &mut Value) {
    for field in ["stateSegments", "appUsage"] {
        let Some(items) = snapshot.get_mut(field).and_then(Value::as_array_mut) else {
            continue;
        };
        let mut compacted: Vec<Value> = Vec::with_capacity(items.len());
        for item in items.drain(..) {
            let merge = compacted.last().is_some_and(|last| {
                let contiguous = last.get("end") == item.get("start") && last.get("end").is_some();
                let same = match (last.as_object(), item.as_object()) {
                    (Some(left), Some(right)) => {
                        let metadata =
                            |key: &&String| !matches!(key.as_str(), "id" | "start" | "end");
                        left.keys()
                            .filter(metadata)
                            .chain(right.keys().filter(metadata))
                            .all(|key| left.get(key) == right.get(key))
                    }
                    _ => false,
                };
                contiguous && same
            });
            if merge {
                compacted.last_mut().unwrap()["end"] = item["end"].clone();
            } else {
                compacted.push(item);
            }
        }
        *items = compacted;
    }
}

fn read_json_file(path: &Path, default_value: Value) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(default_value)
}

fn merge_json_array_by_id<F>(current: &mut Value, recovered: &Value, mut include: F)
where
    F: FnMut(&Value) -> bool,
{
    if !current.is_array() {
        *current = json!([]);
    }
    let Some(current_items) = current.as_array_mut() else {
        return;
    };
    let mut ids = current_items
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let Some(recovered_items) = recovered.as_array() else {
        return;
    };
    for item in recovered_items {
        if !include(item) {
            continue;
        }
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        if ids.insert(id.to_string()) {
            current_items.push(item.clone());
        }
    }
    current_items.sort_by(|left, right| {
        let left_time = left
            .get("start")
            .or_else(|| left.get("time"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let right_time = right
            .get("start")
            .or_else(|| right.get("time"))
            .and_then(Value::as_str)
            .unwrap_or("");
        left_time.cmp(right_time)
    });
}

fn restore_focus_break_fields(current: &mut Value, recovered_snapshots: &[Value]) {
    if !current.is_array() {
        *current = json!([]);
    }
    let mut recovered_by_id = HashMap::<String, serde_json::Map<String, Value>>::new();
    for recovered in recovered_snapshots {
        let Some(items) = recovered.as_array() else {
            continue;
        };
        for item in items {
            let (Some(id), Some(object)) =
                (item.get("id").and_then(Value::as_str), item.as_object())
            else {
                continue;
            };
            let recovered = recovered_by_id.entry(id.to_string()).or_default();
            for key in ["autoStartBreak", "breakDurationSeconds"] {
                if !recovered.contains_key(key) {
                    if let Some(value) = object.get(key) {
                        recovered.insert(key.to_string(), value.clone());
                    }
                }
            }
        }
    }
    let Some(items) = current.as_array_mut() else {
        return;
    };
    for item in items {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        let recovered = object
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| recovered_by_id.get(id));
        if !object.contains_key("autoStartBreak") {
            object.insert(
                "autoStartBreak".to_string(),
                recovered
                    .and_then(|value| value.get("autoStartBreak"))
                    .cloned()
                    .unwrap_or(json!(true)),
            );
        }
        if !object.contains_key("breakDurationSeconds") {
            object.insert(
                "breakDurationSeconds".to_string(),
                recovered
                    .and_then(|value| value.get("breakDurationSeconds"))
                    .cloned()
                    .unwrap_or_else(|| json!(5 * 60)),
            );
        }
    }
}

fn recovered_setting(recovered: &[Value], pointer: &str) -> Option<Value> {
    recovered
        .iter()
        .find_map(|settings| settings.pointer(pointer).cloned())
}

fn restore_break_settings(current: &mut Value, recovered: &[Value]) {
    if !current.is_object() {
        *current = json!({});
    }
    let Some(settings) = current.as_object_mut() else {
        return;
    };
    for (key, pointer, default_value) in [
        ("autoStartBreak", "/autoStartBreak", json!(true)),
        ("breakMinutes", "/breakMinutes", json!(5)),
    ] {
        if !settings.contains_key(key) {
            settings.insert(
                key.to_string(),
                recovered_setting(recovered, pointer).unwrap_or(default_value),
            );
        }
    }
    let reminder = settings
        .entry("reminder".to_string())
        .or_insert_with(|| json!({}));
    if !reminder.is_object() {
        *reminder = json!({});
    }
    let Some(reminder) = reminder.as_object_mut() else {
        return;
    };
    for (key, pointer, default_value) in [
        (
            "enableFocusRestNudges",
            "/reminder/enableFocusRestNudges",
            json!(true),
        ),
        ("longFocusMinutes", "/reminder/longFocusMinutes", json!(45)),
        (
            "veryLongFocusMinutes",
            "/reminder/veryLongFocusMinutes",
            json!(90),
        ),
    ] {
        if !reminder.contains_key(key) {
            reminder.insert(
                key.to_string(),
                recovered_setting(recovered, pointer).unwrap_or(default_value),
            );
        }
    }
}

fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let source_wide = source
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination_wide = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let replaced = unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if replaced == 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    fs::rename(source, destination)
}

#[derive(Debug, Eq, PartialEq)]
enum MetadataState {
    Current,
    Missing,
    Invalid,
    Unsupported(String),
}

fn fallback_data_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(".").to_path_buf());
    #[cfg(target_os = "macos")]
    {
        home.join("Library/Application Support/Focus Pet")
    }
    #[cfg(target_os = "windows")]
    {
        windows_local_app_data_dir()
            .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join(WINDOWS_APP_SUPPORT_FOLDER)
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("Focus Pet")
    }
}

#[cfg(target_os = "windows")]
fn windows_local_app_data_dir() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::core::GUID;
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_LocalAppData, FOLDERID_Profile, SHGetKnownFolderPath},
    };

    fn known_folder(id: &GUID) -> Option<PathBuf> {
        let mut raw_path = std::ptr::null_mut();
        let result = unsafe { SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut raw_path) };
        if result < 0 || raw_path.is_null() {
            return None;
        }
        let mut length = 0usize;
        while unsafe { *raw_path.add(length) } != 0 {
            length += 1;
        }
        let path = PathBuf::from(std::ffi::OsString::from_wide(unsafe {
            std::slice::from_raw_parts(raw_path, length)
        }));
        unsafe { CoTaskMemFree(raw_path.cast()) };
        Some(path)
    }

    // FOLDERID_LocalAppData is package-virtualized when a normal executable is
    // launched by an MSIX parent. The profile
    // folder is stable across launchers, so derive the conventional local data
    // root from it before falling back to the virtualizable known folder.
    windows_user_profile_dir()
        .map(|profile| profile.join("AppData/Local"))
        .or_else(|| {
            known_folder(&FOLDERID_Profile)
                .map(|profile| profile.join("AppData/Local"))
                .or_else(|| known_folder(&FOLDERID_LocalAppData))
        })
}

#[cfg(target_os = "windows")]
fn windows_user_profile_dir() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::TOKEN_QUERY,
        System::Threading::{GetCurrentProcess, OpenProcessToken},
        UI::Shell::GetUserProfileDirectoryW,
    };

    let mut token: HANDLE = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let result = (|| {
        let mut size = 0u32;
        unsafe { GetUserProfileDirectoryW(token, std::ptr::null_mut(), &mut size) };
        if size == 0 {
            return None;
        }
        let mut buffer = vec![0u16; size as usize];
        if unsafe { GetUserProfileDirectoryW(token, buffer.as_mut_ptr(), &mut size) } == 0 {
            return None;
        }
        let length = buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len());
        Some(PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..length],
        )))
    })();
    unsafe { CloseHandle(token) };
    result
}

#[cfg(any(target_os = "windows", test))]
fn migrate_store_root_if_needed(source: &Path, destination: &Path) -> io::Result<bool> {
    if source == destination
        || destination.join("schema.json").exists()
        || destination
            .read_dir()
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false)
        || !source.join("schema.json").is_file()
    {
        return Ok(false);
    }
    if destination.exists() {
        fs::remove_dir_all(destination)?;
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(source, destination).is_err() {
        copy_dir_all(source, destination)?;
    }
    Ok(destination.join("schema.json").is_file())
}

#[cfg(target_os = "windows")]
fn migrate_store_contents_if_needed(source: &Path, destination: &Path) -> io::Result<bool> {
    if source == destination
        || destination.join("schema.json").exists()
        || destination
            .read_dir()
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false)
        || !source.join("schema.json").is_file()
    {
        return Ok(false);
    }
    fs::create_dir_all(destination)?;
    for name in [
        "schema.json",
        "settings.json",
        "classification-rules.json",
        "state-segments.json",
        "app-usage.json",
        "input-activity.json",
        "focus-sessions.json",
        "break-sessions.json",
        "nudges.json",
        "PetPacks",
        "Logs",
    ] {
        let source_entry = source.join(name);
        if source_entry.is_dir() {
            copy_dir_all(&source_entry, &destination.join(name))?;
        } else if source_entry.is_file() {
            fs::copy(&source_entry, destination.join(name))?;
        }
    }
    Ok(destination.join("schema.json").is_file())
}

fn legacy_roots(parent: &Path, root: &Path) -> Vec<PathBuf> {
    LEGACY_APP_SUPPORT_FOLDERS
        .iter()
        .map(|folder| parent.join(folder))
        .filter(|path| path != root)
        .collect()
}

fn sanitized_backup_reason(reason: &str) -> String {
    let mut cleaned = String::with_capacity(reason.len());
    for character in reason.chars() {
        if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
            cleaned.push(character);
        } else if !cleaned.ends_with('-') {
            cleaned.push('-');
        }
    }
    let compacted = cleaned.trim_matches('-').to_string();
    if compacted.is_empty() {
        "schema".to_string()
    } else {
        compacted
    }
}

fn copy_dir_all(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in WalkDir::new(source) {
        let entry = entry?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(io::Error::other)?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        migrate_store_root_if_needed, read_json_file, FocusPetStore, MetadataState,
        DATA_MIGRATION_VERSION, SCHEMA_VERSION,
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn history_compaction_is_lossless_and_does_not_fill_gaps() {
        let segment = |id, start, end, state| {
            json!({
                "id": id, "start": start, "end": end, "state": state,
                "bundleID": null, "appName": "Locked Screen", "category": "ignore",
            })
        };
        let mut snapshot = json!({"stateSegments": [
            segment("a", "00", "01", "away"), segment("b", "01", "02", "away"),
            segment("c", "03", "04", "away"), segment("d", "04", "05", "focus"),
        ]});
        super::compact_history(&mut snapshot);
        let items = snapshot["stateSegments"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["start"], "00");
        assert_eq!(items[0]["end"], "02");
        assert_eq!(items[1]["start"], "03");
        let first = snapshot.clone();
        super::compact_history(&mut snapshot);
        assert_eq!(snapshot, first);
    }

    #[test]
    fn snapshot_shape_matches_frontend_store_contract() {
        let snapshot = json!({
            "settings": {},
            "classificationRules": [],
            "stateSegments": [],
            "appUsage": [],
            "inputActivity": [],
            "focusSessions": [],
            "breakSessions": [],
            "nudges": []
        });

        for key in [
            "settings",
            "classificationRules",
            "stateSegments",
            "appUsage",
            "inputActivity",
            "focusSessions",
            "nudges",
        ] {
            assert!(snapshot.get(key).is_some(), "missing {key}");
        }
    }

    #[test]
    fn store_writes_current_schema_metadata() {
        let root = temp_store_root("current-schema");
        let store = FocusPetStore::from_root(root.clone());
        store.save_snapshot(&json!({ "settings": {} })).unwrap();
        let metadata = fs::read_to_string(root.join("schema.json")).unwrap();
        assert!(metadata.contains(SCHEMA_VERSION));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn store_atomically_replaces_existing_snapshot_files() {
        let root = temp_store_root("replace-existing-snapshot");
        let store = FocusPetStore::from_root(root.clone());
        store
            .save_snapshot(&json!({ "settings": { "focusTargetMinutes": 25 } }))
            .unwrap();
        store
            .save_snapshot(&json!({ "settings": { "focusTargetMinutes": 50 } }))
            .unwrap();

        let snapshot = store.load_snapshot().unwrap();
        assert_eq!(snapshot["settings"]["focusTargetMinutes"], 50);
        assert!(!root.join("settings.json.tmp").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn classification_rule_save_preserves_history_files() {
        let root = temp_store_root("classification-rules-only");
        let store = FocusPetStore::from_root(root.clone());
        store
            .save_snapshot(&json!({
                "settings": {},
                "classificationRules": [],
                "stateSegments": [{"id": "kept-history"}]
            }))
            .unwrap();
        store
            .save_classification_rules(&json!([{"id": "rule-1", "category": "work"}]))
            .unwrap();

        let snapshot = store.load_snapshot().unwrap();
        assert_eq!(snapshot["classificationRules"][0]["id"], "rule-1");
        assert_eq!(snapshot["stateSegments"][0]["id"], "kept-history");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn store_migrates_legacy_root_when_current_root_is_empty() {
        let parent = temp_store_root("legacy-parent");
        let root = parent.join("Focus Pet");
        let legacy = parent.join("FocusPetMVP");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(
            legacy.join("schema.json"),
            format!(r#"{{"schemaVersion":"{}"}}"#, SCHEMA_VERSION),
        )
        .unwrap();
        fs::write(legacy.join("settings.json"), r#"{"focusTargetMinutes":42}"#).unwrap();

        let store = FocusPetStore::from_root(root.clone());
        store.load_snapshot().unwrap();
        assert!(root.join("settings.json").exists());
        assert!(!legacy.exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn windows_store_location_migration_preserves_existing_data() {
        let parent = temp_store_root("windows-location-migration");
        let legacy = parent.join("Roaming/Focus Pet");
        let destination = parent.join("Local/com.focuspet.FocusPet");
        fs::create_dir_all(legacy.join("PetPacks/demo")).unwrap();
        fs::write(
            legacy.join("schema.json"),
            format!(r#"{{"schemaVersion":"{}"}}"#, SCHEMA_VERSION),
        )
        .unwrap();
        fs::write(legacy.join("PetPacks/demo/pet.json"), "{}").unwrap();

        assert!(migrate_store_root_if_needed(&legacy, &destination).unwrap());
        assert!(destination.join("schema.json").is_file());
        assert!(destination.join("PetPacks/demo/pet.json").is_file());
        assert!(!migrate_store_root_if_needed(&legacy, &destination).unwrap());
        let _ = fs::remove_dir_all(parent);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_install_directory_migration_copies_only_user_data() {
        let parent = temp_store_root("windows-install-dir-migration");
        let old_install_dir = parent.join("Focus Pet");
        let destination = parent.join("Focus Pet Data");
        fs::create_dir_all(old_install_dir.join("PetPacks/demo")).unwrap();
        fs::write(
            old_install_dir.join("schema.json"),
            format!(r#"{{"schemaVersion":"{}"}}"#, SCHEMA_VERSION),
        )
        .unwrap();
        fs::write(old_install_dir.join("PetPacks/demo/pet.json"), "{}").unwrap();
        fs::write(old_install_dir.join("focus-pet.exe"), "application").unwrap();
        fs::write(old_install_dir.join("uninstall.exe"), "uninstaller").unwrap();

        assert!(super::migrate_store_contents_if_needed(&old_install_dir, &destination).unwrap());
        assert!(destination.join("schema.json").is_file());
        assert!(destination.join("PetPacks/demo/pet.json").is_file());
        assert!(!destination.join("focus-pet.exe").exists());
        assert!(!destination.join("uninstall.exe").exists());
        assert!(old_install_dir.join("schema.json").is_file());
        let _ = fs::remove_dir_all(parent);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_user_profile_is_stable_outside_package_local_cache() {
        let profile = super::windows_user_profile_dir().expect("Windows user profile resolves");
        assert!(profile.is_dir());
        assert!(!profile.to_string_lossy().contains("LocalCache"));
        assert!(!profile.to_string_lossy().contains("\\Packages\\"));
    }

    #[test]
    fn store_restores_break_data_losslessly_from_pre_tauri_backup() {
        let parent = temp_store_root("restore-break-data");
        let root = parent.join("Focus Pet");
        let backup = parent.join("Focus Pet Backup 20260707T120000Z pre-tauri");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&backup).unwrap();
        fs::write(
            root.join("schema.json"),
            format!(r#"{{"schemaVersion":"{}"}}"#, SCHEMA_VERSION),
        )
        .unwrap();
        fs::write(root.join("break-sessions.json"), "[]").unwrap();
        fs::write(
            root.join("state-segments.json"),
            r#"[{"id":"keep","state":"focus"}]"#,
        )
        .unwrap();
        fs::write(
            root.join("focus-sessions.json"),
            r#"[{"id":"focus","taskName":"Keep current"}]"#,
        )
        .unwrap();
        fs::write(
            root.join("settings.json"),
            r#"{"focusTargetMinutes":25,"reminder":{}}"#,
        )
        .unwrap();
        fs::write(
            backup.join("break-sessions.json"),
            r#"[{"id":"break-1","start":"2026-07-07T10:00:00Z","source":"manual"}]"#,
        )
        .unwrap();
        fs::write(
            backup.join("state-segments.json"),
            r#"[{"id":"old-break","state":"break","start":"2026-07-07T10:00:00Z"},{"id":"old-focus","state":"focus"}]"#,
        )
        .unwrap();
        fs::write(
            backup.join("focus-sessions.json"),
            r#"[{"id":"focus","autoStartBreak":false,"breakDurationSeconds":420}]"#,
        )
        .unwrap();
        fs::write(
            backup.join("nudges.json"),
            r#"[{"id":"rest-nudge","reason":"longFocusRest","time":"2026-07-07T10:00:00Z"},{"id":"other","reason":"welcomeBack"}]"#,
        )
        .unwrap();
        fs::write(
            backup.join("settings.json"),
            r#"{"autoStartBreak":false,"breakMinutes":7,"reminder":{"enableFocusRestNudges":false,"longFocusMinutes":50,"veryLongFocusMinutes":100}}"#,
        )
        .unwrap();

        let store = FocusPetStore::from_root(root.clone());
        let snapshot = store.load_snapshot().unwrap();
        assert_eq!(snapshot["breakSessions"][0]["id"], "break-1");
        assert_eq!(snapshot["stateSegments"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["focusSessions"][0]["autoStartBreak"], false);
        assert_eq!(snapshot["focusSessions"][0]["breakDurationSeconds"], 420);
        assert_eq!(snapshot["settings"]["autoStartBreak"], false);
        assert_eq!(snapshot["settings"]["breakMinutes"], 7);
        assert_eq!(snapshot["settings"]["reminder"]["longFocusMinutes"], 50);
        assert_eq!(snapshot["nudges"].as_array().unwrap().len(), 1);
        assert_eq!(
            read_json_file(&root.join("schema.json"), json!({}))["dataMigrationVersion"],
            DATA_MIGRATION_VERSION
        );
        let second = store.load_snapshot().unwrap();
        assert_eq!(second, snapshot, "migration must be idempotent");
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn unsupported_schema_is_backed_up_and_blocks_writes() {
        let parent = temp_store_root("unsupported-parent");
        let root = parent.join("Focus Pet");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("schema.json"), r#"{"schemaVersion":"future"}"#).unwrap();
        fs::write(root.join("settings.json"), "{}").unwrap();
        let store = FocusPetStore::from_root(root.clone());

        assert_eq!(
            store.metadata_state().unwrap(),
            MetadataState::Unsupported("future".to_string())
        );
        assert!(store.load_snapshot().is_ok());
        assert!(store.save_snapshot(&json!({ "settings": {} })).is_err());
        let backups = fs::read_dir(&parent)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("unsupported-schema-future")
            })
            .count();
        assert_eq!(backups, 1);
        let _ = fs::remove_dir_all(parent);
    }

    fn temp_store_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "focus-pet-tauri-store-test-{label}-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let _ = fs::remove_dir_all(&root);
        root
    }
}
