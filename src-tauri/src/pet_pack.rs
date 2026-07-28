use serde::Serialize;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPetPack {
    pub id: String,
    pub name: String,
    pub author: String,
    pub style: String,
    pub license: String,
    pub distribution: String,
    pub path: String,
    pub preview_url: Option<String>,
    pub pack: Value,
    pub validation: PetPackImportValidation,
    pub source_action_assets: Vec<PetSourceActionAssets>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSourceActionAssets {
    pub id: String,
    pub frame_urls: Vec<String>,
    pub audio_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPackImportValidation {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub is_valid: bool,
}

#[cfg(test)]
pub fn import_pet_pack(source: &Path, library_dir: &Path) -> io::Result<ImportedPetPack> {
    let source_roots = source_roots(source)?;
    let source_root =
        source_roots.roots.first().cloned().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "pet pack manifest not found")
        })?;
    validate_pack_roots(&[source_root.clone()])?;
    let imported = import_pack_root(&source_root, library_dir);
    drop(source_roots);
    imported
}

pub fn import_pet_packs(source: &Path, library_dir: &Path) -> io::Result<Vec<ImportedPetPack>> {
    let source_roots = source_roots(source)?;
    if source_roots.roots.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "pet pack manifest not found",
        ));
    }
    validate_pack_roots(&source_roots.roots)?;
    let imported: io::Result<Vec<_>> = source_roots
        .roots
        .iter()
        .map(|root| import_pack_root(root, library_dir))
        .collect();
    drop(source_roots);
    imported
}

pub fn list_pet_packs(library_dir: &Path) -> io::Result<Vec<ImportedPetPack>> {
    if !library_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut roots = fs::read_dir(library_dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join("pet.json").is_file())
        .collect::<Vec<_>>();
    roots.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    roots
        .into_iter()
        .map(|root| record_from_root(&root, false))
        .collect()
}

pub fn delete_pet_pack(library_dir: &Path, id: &str) -> io::Result<bool> {
    let target = library_dir.join(safe_path_segment(id));
    if !target.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(target)?;
    Ok(true)
}

pub fn pet_pack_assets(library_dir: &Path, id: &str) -> io::Result<Vec<PetSourceActionAssets>> {
    let root = library_dir.join(safe_path_segment(id));
    if !root.join("pet.json").is_file() {
        return Ok(Vec::new());
    }
    let manifest = read_manifest(&root)?;
    Ok(source_action_assets(&manifest, &root))
}

pub fn choose_pet_pack_source(app: &tauri::AppHandle) -> Option<PathBuf> {
    let folder_label = "选择文件夹".to_string();
    let file_label = "选择文件".to_string();
    let cancel_label = "取消".to_string();
    let choice = app
        .dialog()
        .message("请选择包含 pet.json 的文件夹，或选择 .zip / pet.json 文件。")
        .title("导入 Focus Pet 资源包")
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            folder_label.clone(),
            file_label.clone(),
            cancel_label,
        ))
        .blocking_show_with_result();

    let selected = match choice {
        MessageDialogResult::Yes => app
            .dialog()
            .file()
            .set_title("选择 Focus Pet 资源包文件夹")
            .blocking_pick_folder(),
        MessageDialogResult::No => app
            .dialog()
            .file()
            .set_title("选择 Focus Pet .zip 或 pet.json")
            .add_filter("Focus Pet 资源包", &["zip", "json"])
            .blocking_pick_file(),
        MessageDialogResult::Custom(label) if label == folder_label => app
            .dialog()
            .file()
            .set_title("选择 Focus Pet 资源包文件夹")
            .blocking_pick_folder(),
        MessageDialogResult::Custom(label) if label == file_label => app
            .dialog()
            .file()
            .set_title("选择 Focus Pet .zip 或 pet.json")
            .add_filter("Focus Pet 资源包", &["zip", "json"])
            .blocking_pick_file(),
        _ => None,
    };
    selected.and_then(|path| path.into_path().ok())
}

fn record_from_root(
    root: &Path,
    include_source_action_assets: bool,
) -> io::Result<ImportedPetPack> {
    let manifest = read_manifest(root)?;
    let validation = validate_manifest(&manifest, root);
    let source_action_assets = if include_source_action_assets {
        source_action_assets(&manifest, root)
    } else {
        Vec::new()
    };
    let id = string_field(&manifest, "id").unwrap_or_else(|| "imported-pet-pack".to_string());
    let preview_url = ["preview.png", "preview.jpg", "preview.jpeg", "preview.gif"]
        .iter()
        .map(|file_name| root.join(file_name))
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().to_string());
    Ok(ImportedPetPack {
        id: id.clone(),
        name: string_field(&manifest, "name").unwrap_or(id),
        author: string_field(&manifest, "author").unwrap_or_else(|| "Focus Pet".to_string()),
        style: string_field(&manifest, "style").unwrap_or_else(|| "custom".to_string()),
        license: license_field(&manifest).unwrap_or_default(),
        distribution: string_field(&manifest, "distribution").unwrap_or_default(),
        path: root.to_string_lossy().to_string(),
        preview_url,
        pack: manifest,
        validation,
        source_action_assets,
    })
}

fn source_action_assets(manifest: &Value, root: &Path) -> Vec<PetSourceActionAssets> {
    manifest
        .get("sourceActions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|action| {
            let id = string_field(action, "id")?;
            let folder = string_field(action, "folder")?;
            let frame_urls = frame_urls(root, &folder);
            let audio_url = action
                .get("audio")
                .and_then(audio_file_field)
                .and_then(|file| safe_asset_path(root, &file))
                .filter(|path| path.is_file())
                .map(|path| path.to_string_lossy().to_string());
            Some(PetSourceActionAssets {
                id,
                frame_urls,
                audio_url,
            })
        })
        .collect()
}

fn frame_urls(root: &Path, folder: &str) -> Vec<String> {
    let Some(folder_path) = safe_asset_path(root, folder) else {
        return Vec::new();
    };
    let mut frames = fs::read_dir(folder_path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_user_asset_file(path, "png"))
        .collect::<Vec<_>>();
    frames.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    frames
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

fn safe_asset_path(root: &Path, relative: &str) -> Option<PathBuf> {
    use std::path::Component;

    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || !relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(root.join(relative))
}

fn audio_file_field(value: &Value) -> Option<String> {
    match value {
        Value::String(file) => Some(file.clone()),
        Value::Object(record) => record
            .get("file")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn import_pack_root(source_root: &Path, library_dir: &Path) -> io::Result<ImportedPetPack> {
    let manifest = read_manifest(source_root)?;
    let validation = validate_manifest(&manifest, source_root);
    let id = string_field(&manifest, "id").unwrap_or_else(|| "imported-pet-pack".to_string());
    let destination = library_dir.join(safe_path_segment(&id));
    fs::create_dir_all(library_dir)?;

    let source_canonical = source_root.canonicalize().ok();
    let destination_canonical = destination.canonicalize().ok();
    let is_same_location = source_canonical.is_some()
        && destination_canonical.is_some()
        && source_canonical == destination_canonical;

    if !validation.is_valid {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "pet pack validation failed: {}",
                validation.errors.join(", ")
            ),
        ));
    }

    if !is_same_location {
        if destination.exists() {
            fs::remove_dir_all(&destination)?;
        }
        copy_dir_all(source_root, &destination)?;
    }

    record_from_root(&destination, true)
}

fn validate_pack_roots(roots: &[PathBuf]) -> io::Result<()> {
    for root in roots {
        let manifest = read_manifest(root)?;
        let validation = validate_manifest(&manifest, root);
        if !validation.is_valid {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "pet pack validation failed: {}",
                    validation.errors.join(", ")
                ),
            ));
        }
    }
    Ok(())
}

struct SourceRoots {
    roots: Vec<PathBuf>,
    temporary_root: Option<PathBuf>,
}

impl Drop for SourceRoots {
    fn drop(&mut self) {
        if let Some(root) = &self.temporary_root {
            let _ = fs::remove_dir_all(root);
        }
    }
}

fn source_roots(source: &Path) -> io::Result<SourceRoots> {
    if source.is_dir() {
        if source.join("pet.json").is_file() {
            return Ok(SourceRoots {
                roots: vec![source.to_path_buf()],
                temporary_root: None,
            });
        }
        return Ok(SourceRoots {
            roots: importable_pack_roots(source, false),
            temporary_root: None,
        });
    }

    if source
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return archive_roots(source);
    }

    if source.file_name().and_then(|value| value.to_str()) == Some("pet.json") {
        let root = source.parent().map(Path::to_path_buf).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "pet.json has no parent folder")
        })?;
        return Ok(SourceRoots {
            roots: vec![root],
            temporary_root: None,
        });
    }

    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "select a pet pack folder, pet.json, or zip archive",
    ))
}

fn archive_roots(source: &Path) -> io::Result<SourceRoots> {
    let temporary_root = std::env::temp_dir().join(format!(
        "focus-pet-import-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::create_dir_all(&temporary_root)?;
    extract_zip(source, &temporary_root).inspect_err(|_| {
        let _ = fs::remove_dir_all(&temporary_root);
    })?;
    let roots = importable_pack_roots(&temporary_root, true);
    if roots.is_empty() {
        let _ = fs::remove_dir_all(&temporary_root);
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "zip archive does not contain pet.json",
        ));
    }
    Ok(SourceRoots {
        roots,
        temporary_root: Some(temporary_root),
    })
}

fn extract_zip(source: &Path, destination: &Path) -> io::Result<()> {
    let file = fs::File::open(source)?;
    let mut archive = zip::ZipArchive::new(file).map_err(io::Error::other)?;
    let canonical_destination = destination.canonicalize()?;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(io::Error::other)?;
        let Some(enclosed_name) = file.enclosed_name() else {
            continue;
        };
        if is_hidden_metadata_path(&enclosed_name) {
            continue;
        }
        let output_path = canonical_destination.join(enclosed_name);
        if !output_path.starts_with(&canonical_destination) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "zip entry escapes destination",
            ));
        }
        if file.is_dir() {
            fs::create_dir_all(&output_path)?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = fs::File::create(&output_path)?;
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer)?;
        output.write_all(&buffer)?;
    }
    Ok(())
}

fn importable_pack_roots(root: &Path, recursive: bool) -> Vec<PathBuf> {
    if root.join("pet.json").is_file() {
        return vec![root.to_path_buf()];
    }
    if recursive {
        let mut roots = WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_file()
                    && entry.file_name() == "pet.json"
                    && !is_hidden_metadata_path(entry.path())
            })
            .filter_map(|entry| entry.path().parent().map(Path::to_path_buf))
            .filter(|path| !is_hidden_metadata_path(path))
            .collect::<Vec<_>>();
        roots.sort();
        roots.dedup();
        return roots;
    }
    let mut roots = fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join("pet.json").is_file())
        .filter(|path| !is_hidden_metadata_path(path))
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    roots
}

fn read_manifest(root: &Path) -> io::Result<Value> {
    let bytes = fs::read(root.join("pet.json"))?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

fn validate_manifest(manifest: &Value, root: &Path) -> PetPackImportValidation {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        errors.push("unsupportedSchema".to_string());
    }
    if string_field(manifest, "id").is_none_or(|value| value.trim().is_empty()) {
        errors.push("missingID".to_string());
    }
    if string_field(manifest, "name").is_none_or(|value| value.trim().is_empty()) {
        errors.push("missingName".to_string());
    }
    if !root.join("preview.png").is_file() {
        warnings.push("missingPreview".to_string());
    }
    if license_field(manifest).is_none_or(|value| value.trim().is_empty()) {
        warnings.push("missingLicense".to_string());
    }
    if string_field(manifest, "distribution").is_none_or(|value| value.trim().is_empty()) {
        warnings.push("missingDistribution".to_string());
    }

    let mut source_action_ids = HashSet::new();
    for action in manifest
        .get("sourceActions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = string_field(action, "id").filter(|value| !value.trim().is_empty()) else {
            errors.push("missingSourceActionID".to_string());
            continue;
        };
        if !source_action_ids.insert(id.clone()) {
            errors.push(format!("duplicateSourceActionID:{id}"));
        }
        if let Some(folder) = string_field(action, "folder") {
            let folder_path = validate_folder(root, &folder, &mut errors, &id);
            if let (Some(path), Some(expected)) = (
                folder_path,
                action.get("frameCount").and_then(Value::as_u64),
            ) {
                let actual = png_count(&path);
                if actual != expected {
                    errors.push(format!(
                        "frameCountMismatch:sourceAction:{id}:{expected}:{actual}"
                    ));
                }
            }
        } else {
            errors.push(format!("missingAnimationFolder:{id}"));
        }
        if let Some(file) = action.get("audio").and_then(audio_file_field) {
            if safe_asset_path(root, &file).is_none() {
                errors.push(format!("unsafeAudioPath:{id}"));
            }
        }
    }
    if manifest
        .get("sourceActions")
        .and_then(Value::as_array)
        .is_none_or(|actions| actions.is_empty())
        && manifest
            .get("animations")
            .and_then(Value::as_object)
            .is_none_or(|animations| animations.is_empty())
    {
        errors.push("missingSourceActions".to_string());
    }

    if let Some(animations) = manifest.get("animations").and_then(Value::as_object) {
        for (action, spec) in animations {
            if let Some(folder) = string_field(spec, "folder") {
                let folder_path = validate_folder(root, &folder, &mut errors, action);
                if let (Some(path), Some(expected)) =
                    (folder_path, spec.get("frameCount").and_then(Value::as_u64))
                {
                    let actual = png_count(&path);
                    if actual != expected {
                        errors.push(format!("frameCountMismatch:{action}:{expected}:{actual}"));
                    }
                }
            } else {
                errors.push(format!("missingAnimationFolder:{action}"));
            }
        }
    }

    for idle_id in manifest
        .get("idleSourceActionIDs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !source_action_ids.contains(idle_id) {
            errors.push(format!("missingIdleSourceAction:{idle_id}"));
        }
    }

    PetPackImportValidation {
        is_valid: errors.is_empty(),
        errors,
        warnings,
    }
}

fn validate_folder(
    root: &Path,
    folder: &str,
    errors: &mut Vec<String>,
    action: &str,
) -> Option<PathBuf> {
    let Some(folder_path) = safe_asset_path(root, folder) else {
        errors.push(format!("unsafeAnimationFolder:{action}"));
        return None;
    };
    if !folder_path.is_dir() {
        errors.push(format!("missingAnimationFolder:{action}"));
    } else if png_count(&folder_path) == 0 {
        errors.push(format!("missingAnimationFrames:{action}"));
    }
    Some(folder_path)
}

fn png_count(path: &Path) -> u64 {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| is_user_asset_file(&entry.path(), "png"))
        .count() as u64
}

fn copy_dir_all(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in WalkDir::new(source) {
        let entry = entry?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(io::Error::other)?;
        if is_hidden_metadata_path(relative) {
            continue;
        }
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn is_user_asset_file(path: &Path, extension: &str) -> bool {
    !is_hidden_metadata_path(path)
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
}

fn is_hidden_metadata_path(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        name == "__MACOSX" || name == ".DS_Store" || name.starts_with("._")
    })
}

fn safe_path_segment(value: &str) -> String {
    let safe = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if safe.is_empty() {
        "imported-pet-pack".to_string()
    } else {
        safe
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn license_field(value: &Value) -> Option<String> {
    match value.get("license") {
        Some(Value::String(license)) => Some(license.clone()),
        Some(Value::Object(license)) => Some(
            [
                license.get("type").and_then(Value::as_str),
                license.get("note").and_then(Value::as_str),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · "),
        ),
        _ => None,
    }
}

#[cfg(test)]
pub fn minimal_pack_manifest() -> Value {
    manifest_for_pack("demo", "Demo")
}

#[cfg(test)]
pub fn manifest_for_pack(id: &str, name: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "id": id,
        "name": name,
        "author": "Focus Pet",
        "style": "test",
        "license": "localOnly",
        "distribution": "localOnly",
        "defaultSize": { "width": 120, "height": 120 },
        "anchor": { "x": 0.5, "y": 1 },
        "animations": {
            "idle": { "folder": "idle", "fps": 8, "loop": true, "frameCount": 1 }
        },
        "sourceActions": [
            { "id": "idle", "title": "Idle", "folder": "idle", "fps": 8, "loop": true, "frameCount": 1 }
        ],
        "idleSourceActionIDs": ["idle"]
    })
}

#[cfg(test)]
mod tests {
    use super::{
        delete_pet_pack, import_pet_pack, import_pet_packs, list_pet_packs, manifest_for_pack,
        minimal_pack_manifest, pet_pack_assets,
    };
    use std::{
        fs,
        io::Write,
        path::{Path, PathBuf},
    };
    use zip::write::SimpleFileOptions;

    #[test]
    fn imports_folder_pack_and_validates_frames() {
        let root = temp_dir("focus-pet-pack-import");
        let source = root.join("source");
        let library = root.join("library");
        fs::create_dir_all(source.join("idle")).expect("idle folder");
        fs::write(
            source.join("pet.json"),
            serde_json::to_vec_pretty(&minimal_pack_manifest()).unwrap(),
        )
        .unwrap();
        fs::write(source.join("idle/000.png"), []).unwrap();
        fs::write(source.join("preview.png"), []).unwrap();

        let imported = import_pet_pack(&source, &library).expect("pack imports");
        assert_eq!(imported.id, "demo");
        assert!(imported.validation.is_valid);
        assert!(PathBuf::from(imported.path).join("pet.json").is_file());
        assert_eq!(imported.source_action_assets[0].id, "idle");
        assert!(Path::new(&imported.source_action_assets[0].frame_urls[0])
            .ends_with(Path::new("idle").join("000.png")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_source_action_frame_count_mismatches() {
        let root = temp_dir("focus-pet-pack-source-frame-count");
        let source = root.join("source");
        let library = root.join("library");
        fs::create_dir_all(source.join("idle")).unwrap();
        let mut manifest = minimal_pack_manifest();
        manifest["sourceActions"][0]["frameCount"] = serde_json::Value::from(2);
        fs::write(
            source.join("pet.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(source.join("idle/000.png"), []).unwrap();

        let error = import_pet_pack(&source, &library).expect_err("frame mismatch rejects pack");
        assert!(error
            .to_string()
            .contains("frameCountMismatch:sourceAction:idle:2:1"));
        assert!(!library.join("demo").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_animation_and_audio_paths_outside_the_pack() {
        let root = temp_dir("focus-pet-pack-path-traversal");
        let source = root.join("source");
        let library = root.join("library");
        fs::create_dir_all(source.join("idle")).unwrap();
        fs::write(source.join("idle/000.png"), []).unwrap();
        let mut manifest = minimal_pack_manifest();
        manifest["sourceActions"][0]["folder"] = serde_json::Value::from("../outside");
        manifest["sourceActions"][0]["audio"] = serde_json::Value::from("../secret.wav");
        fs::write(
            source.join("pet.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let error = import_pet_pack(&source, &library).expect_err("unsafe paths reject pack");
        let message = error.to_string();
        assert!(message.contains("unsafeAnimationFolder:idle"));
        assert!(message.contains("unsafeAudioPath:idle"));
        assert!(!library.join("demo").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deletes_imported_pack_by_id() {
        let root = temp_dir("focus-pet-pack-delete");
        let source = root.join("source");
        let library = root.join("library");
        fs::create_dir_all(source.join("idle")).expect("idle folder");
        fs::write(
            source.join("pet.json"),
            serde_json::to_vec_pretty(&minimal_pack_manifest()).unwrap(),
        )
        .unwrap();
        fs::write(source.join("idle/000.png"), []).unwrap();

        import_pet_pack(&source, &library).expect("pack imports");
        assert!(delete_pet_pack(&library, "demo").expect("pack deletes"));
        assert!(list_pet_packs(&library).unwrap().is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn lists_imported_library_packs_on_next_launch() {
        let root = temp_dir("focus-pet-pack-list");
        let source = root.join("source");
        let library = root.join("library");
        fs::create_dir_all(source.join("idle")).expect("idle folder");
        fs::write(
            source.join("pet.json"),
            serde_json::to_vec_pretty(&minimal_pack_manifest()).unwrap(),
        )
        .unwrap();
        fs::write(source.join("idle/000.png"), []).unwrap();
        fs::write(source.join("preview.png"), []).unwrap();

        import_pet_pack(&source, &library).expect("pack imports");
        let records = list_pet_packs(&library).expect("library lists");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "demo");
        assert!(
            records[0].source_action_assets.is_empty(),
            "library listing should stay lightweight"
        );
        assert!(pet_pack_assets(&library, "demo")
            .expect("pack assets load")
            .iter()
            .any(|asset| !asset.frame_urls.is_empty()));
        assert!(records[0]
            .preview_url
            .as_deref()
            .is_some_and(|path| path.ends_with("preview.png")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn imports_zip_pack_and_cleans_temporary_extraction() {
        let root = temp_dir("focus-pet-pack-zip");
        let library = root.join("library");
        let zip_path = root.join("demo.zip");
        write_pack_zip(&zip_path, &[("DemoPack", "demo_zip", "Zip Demo")]);

        let imported = import_pet_packs(&zip_path, &library).expect("zip imports");
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].id, "demo_zip");
        assert!(library.join("demo_zip/pet.json").is_file());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn imports_zip_collection_with_multiple_packs() {
        let root = temp_dir("focus-pet-pack-zip-collection");
        let library = root.join("library");
        let zip_path = root.join("collection.zip");
        write_pack_zip(
            &zip_path,
            &[
                ("Collection/One", "zip_one", "Zip One"),
                ("Collection/Two", "zip_two", "Zip Two"),
            ],
        );

        let imported = import_pet_packs(&zip_path, &library).expect("zip collection imports");
        let ids = imported
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["zip_one", "zip_two"]);
        assert_eq!(list_pet_packs(&library).unwrap().len(), 2);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_zip_collection_without_partial_imports() {
        let root = temp_dir("focus-pet-pack-zip-invalid-collection");
        let library = root.join("library");
        let zip_path = root.join("invalid-collection.zip");
        write_custom_pack_zip(
            &zip_path,
            &[
                PackZipEntry {
                    root: "Collection/Good",
                    id: "zip_good",
                    name: "Zip Good",
                    include_frame: true,
                },
                PackZipEntry {
                    root: "Collection/Broken",
                    id: "zip_broken",
                    name: "Zip Broken",
                    include_frame: false,
                },
            ],
        );

        let error = import_pet_packs(&zip_path, &library)
            .expect_err("zip collection rejects invalid packs");
        assert!(error.to_string().contains("missingAnimationFrames:idle"));
        assert!(!library.join("zip_good/pet.json").exists());
        assert!(!library.join("zip_broken/pet.json").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn imports_migrated_local_pet_pack_archives() {
        let fixture_root = repository_root().join("local-pet-packs");
        if !fixture_root.is_dir() {
            return;
        }

        let root = temp_dir("focus-pet-migrated-pack-fixtures");
        let library = root.join("library");
        let cases = [
            ("LuoXiaoHeiLocal.zip", vec!["luo_xiaohei_local"]),
            ("PixelCatMemeLocal.zip", vec!["pixel_cat_meme_local"]),
            ("UNIkeNLocal.zip", vec!["uniken_local"]),
            ("XiaoDaiLocal.zip", vec!["xiaodai_local"]),
            (
                "FocusPetLocalPetPacks.zip",
                vec!["luo_xiaohei_local", "xiaodai_local", "pixel_cat_meme_local"],
            ),
        ];

        for (zip_name, expected_ids) in cases {
            let zip_path = fixture_root.join(zip_name);
            assert!(
                zip_path.is_file(),
                "missing migrated pet-pack fixture {zip_name}"
            );
            let imported = import_pet_packs(&zip_path, &library)
                .unwrap_or_else(|error| panic!("failed to import {zip_name}: {error}"));
            let mut ids = imported
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>();
            ids.sort_unstable();
            let mut expected_ids = expected_ids;
            expected_ids.sort_unstable();
            assert_eq!(ids, expected_ids, "unexpected imported ids for {zip_name}");
            for record in imported {
                assert!(
                    record.validation.is_valid,
                    "{zip_name} imported invalid record"
                );
                assert!(
                    !record.source_action_assets.is_empty(),
                    "{zip_name} imported without source action assets"
                );
                assert!(
                    record
                        .source_action_assets
                        .iter()
                        .any(|asset| !asset.frame_urls.is_empty()),
                    "{zip_name} imported without frame assets"
                );
                assert!(PathBuf::from(record.path).join("pet.json").is_file());
            }
        }

        let records = list_pet_packs(&library).expect("migrated fixtures list");
        assert!(records.len() >= 4);

        let _ = fs::remove_dir_all(root);
    }

    struct PackZipEntry<'a> {
        root: &'a str,
        id: &'a str,
        name: &'a str,
        include_frame: bool,
    }

    fn write_pack_zip(path: &Path, packs: &[(&str, &str, &str)]) {
        let entries = packs
            .iter()
            .map(|(root, id, name)| PackZipEntry {
                root,
                id,
                name,
                include_frame: true,
            })
            .collect::<Vec<_>>();
        write_custom_pack_zip(path, &entries);
    }

    fn write_custom_pack_zip(path: &Path, packs: &[PackZipEntry<'_>]) {
        let file = fs::File::create(path).expect("zip file");
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for PackZipEntry {
            root,
            id,
            name,
            include_frame,
        } in packs
        {
            let normalized = root.trim_matches('/');
            zip.add_directory(format!("{normalized}/"), options)
                .unwrap();
            zip.start_file(format!("{normalized}/pet.json"), options)
                .unwrap();
            zip.write_all(
                serde_json::to_vec_pretty(&manifest_for_pack(id, name))
                    .unwrap()
                    .as_slice(),
            )
            .unwrap();
            zip.add_directory(format!("{normalized}/idle/"), options)
                .unwrap();
            if *include_frame {
                zip.start_file(format!("{normalized}/idle/000.png"), options)
                    .unwrap();
                zip.write_all(&[]).unwrap();
            }
            zip.start_file(format!("{normalized}/preview.png"), options)
                .unwrap();
            zip.write_all(&[]).unwrap();
        }
        zip.finish().expect("zip finish");
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn repository_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has repository parent")
            .to_path_buf()
    }
}
