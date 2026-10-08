//! 后台常驻：关闭主窗口不再退出进程，转为驻留系统托盘。
//!
//! ## 设计取舍
//!
//! - 「关闭窗口时怎么做」的**权威副本放在后端**（[`ResidentState::behavior`]），前端启动时把自己
//!   持久化的选择同步过来。这样命中「最小化到托盘 / 直接退出」时不需要 IPC 往返；
//!   前端还没就绪时一律按「最小化到托盘」兜底 —— 宁可留在托盘，也不能让窗口关不掉。
//! - 托盘右键菜单是常驻期间唯一的控制面：显示主窗口 / Kiro 代理状态 / 关闭行为 / 退出。
//!   「关闭行为」放进菜单，是为了给「记住我的选择」留一个可回退入口
//!   （否则用户在关闭弹窗里勾一次「记住」，就再也改不回来了）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::kiro::{kiro_proxy_summary, KiroProxyState};

/// 主窗口 label，与 `tauri.conf.json` 保持一致。
pub(crate) const MAIN_WINDOW: &str = "main";

const TRAY_ID: &str = "ccm-tray";

const ID_SHOW: &str = "ccm.show";
const ID_KIRO: &str = "ccm.kiro";
const ID_QUIT: &str = "ccm.quit";
const ID_BEHAVIOR_ASK: &str = "ccm.behavior.ask";
const ID_BEHAVIOR_TRAY: &str = "ccm.behavior.tray";
const ID_BEHAVIOR_EXIT: &str = "ccm.behavior.exit";

/// 后端 → 前端：主窗口收到关闭请求，需要用户裁决。
pub(crate) const EVENT_CLOSE_REQUESTED: &str = "resident:close-requested";
/// 后端 → 前端：关闭行为在托盘菜单里被改过，前端需要落盘。
pub(crate) const EVENT_BEHAVIOR_CHANGED: &str = "resident:behavior-changed";

/// Kiro 代理状态轮询间隔。只是刷一个菜单文案，不需要更密。
const KIRO_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// 用户点关闭窗口时的行为。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CloseBehavior {
    /// 每次询问
    Ask,
    /// 最小化到托盘（进程继续跑）
    Tray,
    /// 直接退出
    Exit,
}

impl CloseBehavior {
    fn from_menu_id(id: &str) -> Option<Self> {
        match id {
            ID_BEHAVIOR_ASK => Some(Self::Ask),
            ID_BEHAVIOR_TRAY => Some(Self::Tray),
            ID_BEHAVIOR_EXIT => Some(Self::Exit),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Ask => "每次询问",
            Self::Tray => "最小化到托盘",
            Self::Exit => "直接退出",
        }
    }
}

/// 托盘菜单里需要二次更新的句柄。
struct ResidentMenu {
    kiro_status: MenuItem<Wry>,
    behavior_items: Vec<(CloseBehavior, CheckMenuItem<Wry>)>,
}

/// 常驻态。挂在 Tauri 全局 state 上。
pub(crate) struct ResidentState {
    behavior: Mutex<CloseBehavior>,
    /// 前端是否已经把关闭行为同步过来（未同步前不弹询问，直接常驻）。
    frontend_ready: AtomicBool,
    /// 已进入退出流程：此后放行关闭请求，不再拦截。
    quitting: AtomicBool,
    menu: Mutex<Option<ResidentMenu>>,
}

impl Default for ResidentState {
    fn default() -> Self {
        Self {
            behavior: Mutex::new(CloseBehavior::Ask),
            frontend_ready: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            menu: Mutex::new(None),
        }
    }
}

impl ResidentState {
    fn behavior(&self) -> CloseBehavior {
        self.behavior
            .lock()
            .map(|value| *value)
            .unwrap_or(CloseBehavior::Tray)
    }

    fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn hide_main_window(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        eprintln!("[resident] 未找到主窗口，无法最小化到托盘");
        return;
    };
    if let Err(e) = window.hide() {
        eprintln!("[resident] 隐藏主窗口失败: {e}");
    }
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        eprintln!("[resident] 未找到主窗口，无法显示");
        return;
    };
    // 托盘唤起时窗口可能是「已最小化但未隐藏」，先恢复再聚焦。
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 托盘左键：可见且已聚焦 → 收起；可见但不在前台 → 拉到前台；隐藏 → 显示。
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    if !visible {
        show_main_window(app);
        return;
    }
    if window.is_focused().unwrap_or(false) {
        hide_main_window(app);
    } else {
        let _ = window.set_focus();
    }
}

/// 进入退出流程。`quitting` 置位后，后续的关闭请求会被放行，走正常的退出清理。
pub(crate) fn request_quit(app: &AppHandle) {
    app.state::<ResidentState>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// 处理主窗口关闭请求。返回 `true` 表示已接管，调用方应 `prevent_close()`。
pub(crate) fn on_close_requested(app: &AppHandle) -> bool {
    let state = app.state::<ResidentState>();
    if state.is_quitting() {
        return false;
    }
    let behavior = if state.frontend_ready.load(Ordering::SeqCst) {
        state.behavior()
    } else {
        // 前端还没起来：不做交互，直接常驻
        CloseBehavior::Tray
    };
    drop(state);

    match behavior {
        CloseBehavior::Exit => request_quit(app),
        CloseBehavior::Tray => hide_main_window(app),
        CloseBehavior::Ask => {
            if let Err(e) = app.emit_to(MAIN_WINDOW, EVENT_CLOSE_REQUESTED, ()) {
                eprintln!("[resident] 通知前端弹出关闭询问失败: {e}，改为最小化到托盘");
                hide_main_window(app);
            }
        }
    }
    true
}

/// 更新关闭行为；`notify_frontend` 为真时下发事件让前端落盘（托盘菜单改动的场景）。
fn set_behavior(app: &AppHandle, behavior: CloseBehavior, notify_frontend: bool) {
    let state = app.state::<ResidentState>();
    if let Ok(mut current) = state.behavior.lock() {
        *current = behavior;
    }
    if let Ok(menu) = state.menu.lock() {
        if let Some(menu) = menu.as_ref() {
            for (value, item) in &menu.behavior_items {
                let _ = item.set_checked(*value == behavior);
            }
        }
    }
    drop(state);

    if notify_frontend {
        let _ = app.emit_to(MAIN_WINDOW, EVENT_BEHAVIOR_CHANGED, behavior);
    }
}

fn kiro_status_label(running: bool, port: Option<u16>) -> String {
    match (running, port) {
        (true, Some(port)) => format!("Kiro 代理：运行中 · :{port}"),
        (true, None) => "Kiro 代理：运行中".to_string(),
        (false, _) => "Kiro 代理：已停止".to_string(),
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id: &str = event.id().as_ref();
    match id {
        ID_SHOW => show_main_window(app),
        ID_QUIT => request_quit(app),
        _ => {
            if let Some(behavior) = CloseBehavior::from_menu_id(id) {
                set_behavior(app, behavior, true);
            }
        }
    }
}

fn on_tray_icon_event(tray: &TrayIcon<Wry>, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        toggle_main_window(tray.app_handle());
    }
}

/// 后台刷新托盘菜单里的 Kiro 代理状态（只在文案变化时下发）。
fn spawn_kiro_status_poll(app: AppHandle, tray: TrayIcon<Wry>) {
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            if app.state::<ResidentState>().is_quitting() {
                return;
            }
            let (running, port) = kiro_proxy_summary(&app.state::<KiroProxyState>());
            let label = kiro_status_label(running, port);

            if label != last {
                last = label.clone();
                let app_for_main = app.clone();
                let tray_for_main = tray.clone();
                let tooltip = format!("CodeCliManager · {label}");
                let _ = app.run_on_main_thread(move || {
                    if let Ok(menu) = app_for_main.state::<ResidentState>().menu.lock() {
                        if let Some(menu) = menu.as_ref() {
                            let _ = menu.kiro_status.set_text(&label);
                        }
                    }
                    let _ = tray_for_main.set_tooltip(Some(&tooltip));
                });
            }

            std::thread::sleep(KIRO_POLL_INTERVAL);
        }
    });
}

/// 创建托盘图标与菜单。失败不致命：应用仍可正常使用，只是关闭窗口后无处可唤回。
pub(crate) fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, ID_SHOW, "显示主窗口", true, None::<&str>)?;
    let kiro_status = MenuItem::with_id(app, ID_KIRO, kiro_status_label(false, None), false, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "退出 CodeCliManager", true, None::<&str>)?;

    let behavior_items = vec![
        (
            CloseBehavior::Ask,
            CheckMenuItem::with_id(app, ID_BEHAVIOR_ASK, CloseBehavior::Ask.label(), true, true, None::<&str>)?,
        ),
        (
            CloseBehavior::Tray,
            CheckMenuItem::with_id(app, ID_BEHAVIOR_TRAY, CloseBehavior::Tray.label(), true, false, None::<&str>)?,
        ),
        (
            CloseBehavior::Exit,
            CheckMenuItem::with_id(app, ID_BEHAVIOR_EXIT, CloseBehavior::Exit.label(), true, false, None::<&str>)?,
        ),
    ];
    let behavior_menu = Submenu::with_items(
        app,
        "关闭窗口时",
        true,
        &[
            &behavior_items[0].1 as &dyn IsMenuItem<Wry>,
            &behavior_items[1].1,
            &behavior_items[2].1,
        ],
    )?;

    let separator_top = PredefinedMenuItem::separator(app)?;
    let separator_middle = PredefinedMenuItem::separator(app)?;
    let separator_bottom = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &separator_top,
            &kiro_status,
            &behavior_menu,
            &separator_middle,
            &separator_bottom,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // 左键留给「显示/隐藏窗口」，菜单只在右键出现
        .show_menu_on_left_click(false)
        .tooltip("CodeCliManager · 后台常驻")
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event);

    match app.default_window_icon() {
        Some(icon) => builder = builder.icon(icon.clone()),
        None => eprintln!("[resident] 未取到默认应用图标，托盘图标可能不可见"),
    }

    let tray = builder.build(app)?;

    let state = app.state::<ResidentState>();
    if let Ok(mut slot) = state.menu.lock() {
        *slot = Some(ResidentMenu {
            kiro_status,
            behavior_items,
        });
    }

    spawn_kiro_status_poll(app.clone(), tray);
    eprintln!("[resident] 托盘就绪");
    Ok(())
}

/// 前端启动时同步自己的持久化选择，并标记「前端已就绪」。
#[tauri::command]
pub fn resident_set_close_behavior(app: AppHandle, behavior: CloseBehavior) {
    eprintln!("[resident] 前端已就绪，关闭行为={behavior:?}");
    app.state::<ResidentState>()
        .frontend_ready
        .store(true, Ordering::SeqCst);
    set_behavior(&app, behavior, false);
}

/// 前端关闭询问里选了「最小化到托盘」。
#[tauri::command]
pub fn resident_hide_to_tray(app: AppHandle) {
    hide_main_window(&app);
}

/// 前端关闭询问里选了「直接退出」。
#[tauri::command]
pub fn resident_quit_app(app: AppHandle) {
    request_quit(&app);
}
