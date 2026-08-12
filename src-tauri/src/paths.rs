use std::path::PathBuf;

pub(crate) fn get_data_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("CodeCliManager");
    path
}

pub(crate) fn get_claude_history_path() -> PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".claude");
    path.push("projects");
    path
}

pub(crate) fn get_claude_settings_path() -> PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".claude");
    let settings = path.join("settings.json");
    if settings.exists() {
        return settings;
    }
    let legacy = path.join("claude.json");
    if legacy.exists() {
        return legacy;
    }
    settings
}
