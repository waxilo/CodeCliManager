use tauri::Manager;

mod claude;
mod commands;
mod config;
mod fs;
mod history;
mod kiro;
mod model_fetch;
mod paths;
mod session;
mod shell;
mod updater_manifest;
mod window;

use commands::*;
use kiro::KiroProxyState;
use window::apply_responsive_window_size;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(KiroProxyState::default())
        .setup(|app| {
            updater_manifest::start_updater_manifest_proxy();
            apply_responsive_window_size(app);
            let kiro_state = app.state::<KiroProxyState>().inner().clone();
            kiro::spawn_kiro_autostart(app.handle().clone(), kiro_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_conversations,
            get_current_platform,
            delete_conversation,
            delete_workspace_conversations,
            get_conversation,
            update_conversation_title,
            execute_prompt,
            abort_session,
            respond_tool_permission,
            set_permission_mode,
            retry_message,
            get_claude_api_config,
            get_api_profiles_state,
            get_api_profile_config,
            get_api_profile_key,
            set_active_default_model,
            upsert_api_profile,
            switch_api_profile,
            use_official_api,
            delete_api_profile,
            import_cc_switch_profiles,
            fetch_api_models,
            fetch_deepseek_balance,
            kiro_status,
            kiro_usage,
            kiro_refresh_token,
            kiro_start,
            kiro_stop,
            kiro_models_state,
            kiro_sync_models,
            kiro_save_models_config,
            kiro_set_default_model,
            kiro_prepare_send,
            get_mcp_servers,
            upsert_mcp_server,
            delete_mcp_server,
            list_project_files,
            get_git_branch,
            read_file_content,
            write_file_bytes,
            read_file_base64,
            import_external_path,
            open_terminal,
            open_terminal_resume,
            check_claude_code_update,
            run_claude_code_install,
            run_claude_code_update_silent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
