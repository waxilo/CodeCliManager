use tauri::Manager;

mod claude;
mod claude_global_config;
mod dsh;
mod commands;
mod config;
mod config_io;
mod fs;
mod history;
mod kiro;
mod model_fetch;
mod paths;
mod proc_guard;
mod protocol_guard;
mod session;
mod shell;
mod updater_manifest;
mod usage;
mod window;

use claude_global_config::{
    delete_global_skill, get_global_prompts, get_global_skills, write_global_claude_md,
};
use dsh::{dsh_install, dsh_start, dsh_status, dsh_stop};
use commands::*;
use kiro::KiroProxyState;
use session::{active_session_keys, session_stop_graceful};
use window::apply_responsive_window_size;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(KiroProxyState::default())
        .manage(dsh::DshState::default())
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
            remove_queued_prompt_command,
            clear_queued_prompts_command,
            abort_session,
            stop_all_sessions,
            respond_tool_permission,
            set_permission_mode,
            retry_message,
            reload_session,
            get_claude_api_config,
            get_api_profiles_state,
            get_api_profile_config,
            get_api_profile_key_masked,
            copy_api_profile_key,
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
            export_markdown,
            write_clipboard_image,
            read_file_base64,
            import_external_path,
            open_terminal,
            open_terminal_resume,
            check_claude_code_update,
            run_claude_code_install,
            run_claude_code_update_silent,
            get_global_skills,
            delete_global_skill,
            get_global_prompts,
            write_global_claude_md,
            dsh_status,
            dsh_install,
            dsh_start,
            dsh_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // 兜底：应用退出前优雅关闭所有常驻 claude 进程，
                // 覆盖手动退出 / macOS relaunch（Windows 更新走 stop_all_sessions 命令 + process::exit）。
                let keys = active_session_keys();
                if !keys.is_empty() {
                    eprintln!("[exit] 应用退出，优雅关闭 {} 个常驻会话", keys.len());
                    for key in keys {
                        let _ = session_stop_graceful(&key, "应用退出");
                    }
                }
                dsh::shutdown_dsh_process(&app);
                let _ = app;
            }
        })
}
