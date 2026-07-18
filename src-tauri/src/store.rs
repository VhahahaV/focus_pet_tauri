use chrono::Utc;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const SCHEMA_VERSION: &str = "focuspet-mvp-1";
const COMPATIBLE_SCHEMA_VERSIONS: &[&str] = &["focuspet-tauri-1"];
const APP_SUPPORT_FOLDER: &str = "Focus Pet";
const LEGACY_APP_SUPPORT_FOLDERS: &[&str] = &["FocusPetMVP", "FocusPetV0", "FocusPetLegacy"];

pub struct FocusPetStore {
    root: PathBuf,
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
            let root = windows_local_app_data_dir()
                .map(|directory| directory.join(APP_SUPPORT_FOLDER))
                .unwrap_or_else(|| tauri_local_root.clone());
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

    pub fn root_dir(&self) -> &Path {
        &self.root
    }

    pub fn current_log_file(&self) -> io::Result<PathBuf> {
        self.prepare_store_for_access(true)?;
        let path = self
            .logs_dir()
            .join(format!("focus-pet-{}.log", Utc::now().format("%Y-%m-%d")));
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        writeln!(file, "[{}] log file prepared", Utc::now().to_rfc3339())?;
        Ok(path)
    }

    pub fn pet_packs_dir(&self) -> PathBuf {
        self.root.join("PetPacks")
    }

    pub fn load_snapshot(&self) -> io::Result<Value> {
        self.prepare_store_for_access(false)?;
        Ok(json!({
            "settings": self.read_json("settings.json", json!({}))?,
            "classificationRules": self.read_json("classification-rules.json", json!([]))?,
            "stateSegments": self.read_json("state-segments.json", json!([]))?,
            "appUsage": self.read_json("app-usage.json", json!([]))?,
            "inputActivity": self.read_json("input-activity.json", json!([]))?,
            "focusSessions": self.read_json("focus-sessions.json", json!([]))?,
            "nudges": self.read_json("nudges.json", json!([]))?
        }))
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
        self.write_json("nudges.json", snapshot.get("nudges").unwrap_or(&json!([])))?;
        Ok(())
    }

    pub fn export_snapshot(&self, snapshot: &Value, redacted: bool) -> io::Result<PathBuf> {
        self.prepare_store_for_access(true)?;
        let prefix = if redacted {
            "focus-pet-redacted-export"
        } else {
            "focus-pet-export"
        };
        let path = self
            .root
            .join(format!("{}-{}.json", prefix, Utc::now().timestamp()));
        let bytes = serde_json::to_vec_pretty(snapshot).map_err(io::Error::other)?;
        fs::write(&path, bytes)?;
        Ok(path)
    }

    pub fn delete_all(&self) -> io::Result<()> {
        if self.root.exists() {
            fs::remove_dir_all(&self.root)?;
        }
        self.ensure_root()?;
        self.write_metadata()
    }

    pub fn data_size(&self) -> io::Result<u64> {
        if !self.root.exists() {
            return Ok(0);
        }
        let mut total = 0;
        for entry in WalkDir::new(&self.root).into_iter().filter_map(Result::ok) {
            if entry.file_type().is_file() {
                total += entry.metadata()?.len();
            }
        }
        Ok(total)
    }

    fn prepare_store_for_access(&self, write_intent: bool) -> io::Result<bool> {
        self.migrate_legacy_root_if_needed()?;
        self.ensure_root()?;
        match self.metadata_state()? {
            MetadataState::Current => {
                self.purge_legacy_recovery_data()?;
                self.remove_legacy_roots();
                Ok(true)
            }
            MetadataState::Missing => {
                if self.root_contains_data() {
                    self.backup_root_if_needed("missing-schema")?;
                }
                self.write_metadata()?;
                self.purge_legacy_recovery_data()?;
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
        self.write_json("schema.json", &json!({ "schemaVersion": SCHEMA_VERSION }))
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

    fn purge_legacy_recovery_data(&self) -> io::Result<()> {
        let obsolete_sessions = self.root.join("break-sessions.json");
        if obsolete_sessions.exists() {
            fs::remove_file(obsolete_sessions)?;
        }

        self.rewrite_json_array("state-segments.json", |item| {
            item.get("state").and_then(Value::as_str) != Some("break")
        })?;
        self.rewrite_json_array("nudges.json", |item| {
            !matches!(
                item.get("reason").and_then(Value::as_str),
                Some("longFocusRest" | "veryLongFocusRest" | "breakEnding")
            )
        })?;
        self.rewrite_json_array_objects("focus-sessions.json", |object| {
            object.remove("autoStartBreak");
            object.remove("breakDurationSeconds");
        })?;

        let settings_path = self.root.join("settings.json");
        if settings_path.exists() {
            let bytes = fs::read(&settings_path)?;
            if let Ok(mut settings) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(reminder) = settings.get_mut("reminder").and_then(Value::as_object_mut)
                {
                    reminder.remove("enableFocusRestNudges");
                    reminder.remove("longFocusMinutes");
                    reminder.remove("veryLongFocusMinutes");
                }
                self.write_json("settings.json", &settings)?;
            }
        }
        Ok(())
    }

    fn rewrite_json_array<F>(&self, name: &str, mut keep: F) -> io::Result<()>
    where
        F: FnMut(&Value) -> bool,
    {
        let path = self.root.join(name);
        if !path.exists() {
            return Ok(());
        }
        let bytes = fs::read(&path)?;
        let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
            return Ok(());
        };
        let Some(items) = value.as_array_mut() else {
            return Ok(());
        };
        let original_len = items.len();
        items.retain(|item| keep(item));
        if items.len() != original_len {
            self.write_json(name, &value)?;
        }
        Ok(())
    }

    fn rewrite_json_array_objects<F>(&self, name: &str, mut update: F) -> io::Result<()>
    where
        F: FnMut(&mut serde_json::Map<String, Value>),
    {
        let path = self.root.join(name);
        if !path.exists() {
            return Ok(());
        }
        let bytes = fs::read(&path)?;
        let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
            return Ok(());
        };
        let Some(items) = value.as_array_mut() else {
            return Ok(());
        };
        for item in items {
            if let Some(object) = item.as_object_mut() {
                update(object);
            }
        }
        self.write_json(name, &value)
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
        let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
        if fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) {
            return Ok(());
        }
        fs::write(&temporary, &bytes)?;
        replace_file(&temporary, &path)?;
        Ok(())
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
        return home.join("Library/Application Support/Focus Pet");
    }
    #[cfg(target_os = "windows")]
    {
        return windows_local_app_data_dir()
            .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join(APP_SUPPORT_FOLDER);
    }
    #[cfg(target_os = "linux")]
    {
        return std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("Focus Pet");
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
    // launched by an MSIX parent (for example Codex Computer Use). The profile
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
    use super::{migrate_store_root_if_needed, FocusPetStore, MetadataState, SCHEMA_VERSION};
    use serde_json::json;
    use std::fs;

    #[test]
    fn snapshot_shape_matches_frontend_store_contract() {
        let snapshot = json!({
            "settings": {},
            "classificationRules": [],
            "stateSegments": [],
            "appUsage": [],
            "inputActivity": [],
            "focusSessions": [],
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
    fn windows_user_profile_is_stable_outside_package_local_cache() {
        let profile = super::windows_user_profile_dir().expect("Windows user profile resolves");
        assert!(profile.is_dir());
        assert!(!profile.to_string_lossy().contains("LocalCache"));
        assert!(!profile.to_string_lossy().contains("\\Packages\\"));
    }

    #[test]
    fn store_purges_obsolete_recovery_data_on_load() {
        let root = temp_store_root("purge-obsolete-recovery");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("schema.json"),
            format!(r#"{{"schemaVersion":"{}"}}"#, SCHEMA_VERSION),
        )
        .unwrap();
        fs::write(root.join("break-sessions.json"), "[]").unwrap();
        fs::write(
            root.join("state-segments.json"),
            r#"[{"id":"old","state":"break"},{"id":"keep","state":"focus"}]"#,
        )
        .unwrap();
        fs::write(
            root.join("focus-sessions.json"),
            r#"[{"id":"focus","autoStartBreak":true,"breakDurationSeconds":300}]"#,
        )
        .unwrap();
        fs::write(
            root.join("settings.json"),
            r#"{"reminder":{"enableFocusRestNudges":true,"longFocusMinutes":50,"veryLongFocusMinutes":90}}"#,
        )
        .unwrap();

        let store = FocusPetStore::from_root(root.clone());
        let snapshot = store.load_snapshot().unwrap();
        assert!(!root.join("break-sessions.json").exists());
        assert_eq!(snapshot["stateSegments"].as_array().unwrap().len(), 1);
        assert!(snapshot["focusSessions"][0].get("autoStartBreak").is_none());
        assert!(snapshot["settings"]["reminder"]
            .get("longFocusMinutes")
            .is_none());
        let _ = fs::remove_dir_all(root);
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
