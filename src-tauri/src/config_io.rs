use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

static SETTINGS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static GLOBAL_CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PROJECT_CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static API_PROFILES_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static KIRO_PREFS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock<'a>(cell: &'a OnceLock<Mutex<()>>, name: &str) -> Result<MutexGuard<'a, ()>, String> {
    cell.get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| format!("{name} lock is poisoned"))
}

pub(crate) fn lock_settings() -> Result<MutexGuard<'static, ()>, String> {
    lock(&SETTINGS_LOCK, "settings")
}

pub(crate) fn lock_global_config() -> Result<MutexGuard<'static, ()>, String> {
    lock(&GLOBAL_CONFIG_LOCK, "Claude global config")
}

pub(crate) fn lock_project_config() -> Result<MutexGuard<'static, ()>, String> {
    lock(&PROJECT_CONFIG_LOCK, "Claude project config")
}

pub(crate) fn lock_api_profiles() -> Result<MutexGuard<'static, ()>, String> {
    lock(&API_PROFILES_LOCK, "API profiles")
}

pub(crate) fn lock_kiro_prefs() -> Result<MutexGuard<'static, ()>, String> {
    lock(&KIRO_PREFS_LOCK, "Kiro preferences")
}

pub(crate) fn read_json_or_default<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned + Default,
{
    read_json_or(path, T::default())
}

pub(crate) fn read_json_or<T>(path: &Path, default: T) -> Result<T, String>
where
    T: DeserializeOwned,
{
    if !path.exists() {
        return Ok(default);
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

pub(crate) fn atomic_write_json<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize + ?Sized,
{
    let content = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("Failed to encode {}: {e}", path.display()))?;
    atomic_write(path, &content)
}

pub(crate) fn atomic_write_project_json<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize + ?Sized,
{
    let content = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("Failed to encode {}: {e}", path.display()))?;
    atomic_write_project(path, &content)
}

pub(crate) fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid file name: {}", path.display()))?;
    let mut last_error = None;

    for attempt in 0..32u32 {
        let temp_path = parent.join(format!(
            ".{file_name}.tmp-{}-{attempt}",
            std::process::id()
        ));
        match create_sensitive_temp(&temp_path) {
            Ok(mut file) => {
                let result = (|| {
                    file.write_all(content)
                        .map_err(|e| format!("Failed to write {}: {e}", temp_path.display()))?;
                    file.flush()
                        .map_err(|e| format!("Failed to flush {}: {e}", temp_path.display()))?;
                    file.sync_all()
                        .map_err(|e| format!("Failed to sync {}: {e}", temp_path.display()))?;
                    drop(file);
                    fs::rename(&temp_path, path).map_err(|e| {
                        format!(
                            "Failed to replace {} with {}: {e}",
                            path.display(),
                            temp_path.display()
                        )
                    })?;
                    set_sensitive_permissions(path)?;
                    sync_directory(parent)?;
                    Ok(())
                })();
                if result.is_err() {
                    let _ = fs::remove_file(&temp_path);
                }
                return result;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => {
                return Err(format!(
                    "Failed to create temporary file in {}: {error}",
                    parent.display()
                ));
            }
        }
    }

    Err(format!(
        "Failed to allocate temporary file in {}: {}",
        parent.display(),
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

pub(crate) fn atomic_write_project(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;

    let existing_permissions = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Refusing to replace symlinked project file: {}",
                    path.display()
                ));
            }
            Some(metadata.permissions())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "Failed to inspect project file {}: {error}",
                path.display()
            ));
        }
    };
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid file name: {}", path.display()))?;
    let mut last_error = None;

    for attempt in 0..32u32 {
        let temp_path = parent.join(format!(
            ".{file_name}.tmp-{}-{attempt}",
            std::process::id()
        ));
        match create_project_temp(&temp_path) {
            Ok(mut file) => {
                let result = (|| {
                    file.write_all(content)
                        .map_err(|e| format!("Failed to write {}: {e}", temp_path.display()))?;
                    file.flush()
                        .map_err(|e| format!("Failed to flush {}: {e}", temp_path.display()))?;
                    file.sync_all()
                        .map_err(|e| format!("Failed to sync {}: {e}", temp_path.display()))?;
                    drop(file);
                    fs::rename(&temp_path, path).map_err(|e| {
                        format!(
                            "Failed to replace {} with {}: {e}",
                            path.display(),
                            temp_path.display()
                        )
                    })?;
                    set_project_permissions(path, existing_permissions.clone())?;
                    sync_directory(parent)?;
                    Ok(())
                })();
                if result.is_err() {
                    let _ = fs::remove_file(&temp_path);
                }
                return result;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => {
                return Err(format!(
                    "Failed to create temporary file in {}: {error}",
                    parent.display()
                ));
            }
        }
    }

    Err(format!(
        "Failed to allocate temporary file in {}: {}",
        parent.display(),
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

fn create_project_temp(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(unix)]
fn set_project_permissions(
    path: &Path,
    existing_permissions: Option<fs::Permissions>,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let permissions =
        existing_permissions.unwrap_or_else(|| fs::Permissions::from_mode(0o644));
    fs::set_permissions(path, permissions)
        .map_err(|e| format!("Failed to restore permissions on {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_project_permissions(
    path: &Path,
    existing_permissions: Option<fs::Permissions>,
) -> Result<(), String> {
    if let Some(permissions) = existing_permissions {
        fs::set_permissions(path, permissions)
            .map_err(|e| format!("Failed to restore permissions on {}: {e}", path.display()))?;
    }
    Ok(())
}

fn create_sensitive_temp(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(unix)]
fn set_sensitive_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("Failed to secure {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_sensitive_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("Failed to sync {}: {e}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "codecli-manager-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn atomic_json_write_replaces_content_and_cleans_temp_file() {
        let dir = test_dir("atomic-json");
        let path = dir.join("settings.json");
        fs::write(&path, br#"{"old":true}"#).unwrap();

        atomic_write_json(&path, &json!({ "new": true })).unwrap();

        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value, json!({ "new": true }));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn project_atomic_write_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = test_dir("project-existing-permissions");
        let path = dir.join("CLAUDE.md");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        atomic_write_project(&path, b"new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o644);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn project_atomic_write_creates_non_sensitive_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = test_dir("project-new-permissions");
        let path = dir.join("SKILL.md");

        atomic_write_project(&path, b"new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o644);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn project_atomic_write_rejects_symlink_target() {
        use std::os::unix::fs::symlink;

        let dir = test_dir("project-symlink");
        let outside = test_dir("project-symlink-outside");
        let outside_file = outside.join("target");
        fs::write(&outside_file, "keep").unwrap();
        let path = dir.join("CLAUDE.md");
        symlink(&outside_file, &path).unwrap();

        assert!(atomic_write_project(&path, b"replace").is_err());
        assert_eq!(fs::read_to_string(&outside_file).unwrap(), "keep");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn malformed_existing_json_is_reported() {
        let dir = test_dir("invalid-json");
        let path = dir.join("profiles.json");
        fs::write(&path, "{not-json").unwrap();

        let result = read_json_or_default::<serde_json::Value>(&path);

        assert!(result.unwrap_err().contains("Failed to parse"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{not-json");
        fs::remove_dir_all(dir).unwrap();
    }
}
