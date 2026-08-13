use std::time::Duration;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Position, Size, WebviewWindow};

use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
pub(crate) const WINDOW_ASPECT_WIDTH: f64 = 16.0;
pub(crate) const WINDOW_ASPECT_HEIGHT: f64 = 10.0;
pub(crate) const WINDOW_MAX_SCREEN_RATIO: f64 = 0.85;
pub(crate) const WINDOW_MIN_WIDTH: f64 = 576.0;
pub(crate) const WINDOW_MIN_HEIGHT: f64 = 360.0;

/// 将物理像素转换为逻辑像素
pub(crate) fn physical_to_logical(value: u32, scale_factor: f64) -> f64 {
    value as f64 / scale_factor
}

/// 在屏幕工作区内计算 16:10 比例的最佳窗口尺寸
pub(crate) fn compute_optimal_window_size(screen_width: f64, screen_height: f64) -> (f64, f64) {
    let max_width = screen_width * WINDOW_MAX_SCREEN_RATIO;
    let max_height = screen_height * WINDOW_MAX_SCREEN_RATIO;

    let width_by_width = max_width;
    let height_by_width = width_by_width * WINDOW_ASPECT_HEIGHT / WINDOW_ASPECT_WIDTH;

    let (mut width, mut height) = if height_by_width <= max_height {
        (width_by_width, height_by_width)
    } else {
        let height = max_height;
        let width = height * WINDOW_ASPECT_WIDTH / WINDOW_ASPECT_HEIGHT;
        (width, height)
    };

    if width < WINDOW_MIN_WIDTH {
        width = WINDOW_MIN_WIDTH;
        height = width * WINDOW_ASPECT_HEIGHT / WINDOW_ASPECT_WIDTH;
    }
    if height < WINDOW_MIN_HEIGHT {
        height = WINDOW_MIN_HEIGHT;
        width = height * WINDOW_ASPECT_WIDTH / WINDOW_ASPECT_HEIGHT;
    }

    if width > max_width {
        width = max_width;
        height = width * WINDOW_ASPECT_HEIGHT / WINDOW_ASPECT_WIDTH;
    }
    if height > max_height {
        height = max_height;
        width = height * WINDOW_ASPECT_WIDTH / WINDOW_ASPECT_HEIGHT;
    }

    (width.round(), height.round())
}

/// 根据工作区与窗口外框尺寸，计算居中位置（物理坐标）
pub(crate) fn compute_centered_physical_position(
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    window_width: u32,
    window_height: u32,
) -> (i32, i32) {
    let x = work_x + ((work_width as i32 - window_width as i32) / 2);
    let y = work_y + ((work_height as i32 - window_height as i32) / 2);
    (x, y)
}

pub(crate) fn resolve_target_monitor(window: &WebviewWindow, app: &AppHandle) -> Option<tauri::Monitor> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
}

/// 计算尺寸并将主窗口居中到目标显示器工作区
pub(crate) fn layout_main_window(window: &WebviewWindow, app: &AppHandle) -> bool {
    let Some(monitor) = resolve_target_monitor(window, app) else {
        eprintln!("[window] monitor not found");
        return false;
    };

    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();
    let work_width = physical_to_logical(work_area.size.width, scale_factor);
    let work_height = physical_to_logical(work_area.size.height, scale_factor);
    let (width, height) = compute_optimal_window_size(work_width, work_height);

    eprintln!(
        "[window] work_area={}x{}@({},{}), target={:.0}x{:.0} (16:10)",
        work_area.size.width,
        work_area.size.height,
        work_area.position.x,
        work_area.position.y,
        width,
        height
    );

    if let Err(e) = window.set_size(Size::Logical(LogicalSize::new(width, height))) {
        eprintln!("[window] failed to set size: {e}");
        return false;
    }

    let Ok(outer) = window.outer_size() else {
        eprintln!("[window] failed to read outer size");
        return false;
    };

    let (pos_x, pos_y) = compute_centered_physical_position(
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
        outer.width,
        outer.height,
    );

    eprintln!(
        "[window] outer={}x{}, centered at physical ({}, {})",
        outer.width, outer.height, pos_x, pos_y
    );

    if let Err(e) = window.set_position(Position::Physical(PhysicalPosition::new(pos_x, pos_y))) {
        eprintln!("[window] failed to set position: {e}, fallback to center()");
        let _ = window.center();
        return false;
    }

    true
}

pub(crate) fn schedule_main_window_layout(window: WebviewWindow, app: AppHandle) {
    let applied = Arc::new(AtomicBool::new(false));

    let apply_once = |window: &WebviewWindow, app: &AppHandle, show: bool| {
        if layout_main_window(window, app) && show {
            let _ = window.show();
            let _ = window.set_focus();
        }
    };

    apply_once(&window, &app, true);

    let window_for_main = window.clone();
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        apply_once(&window_for_main, &app_for_main, true);
    });

    let window_for_event = window.clone();
    let app_for_event = app.clone();
    let applied_for_event = Arc::clone(&applied);
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Focused(true)) {
            return;
        }
        if applied_for_event.swap(true, Ordering::SeqCst) {
            return;
        }
        layout_main_window(&window_for_event, &app_for_event);
    });

    let window_for_delay = window.clone();
    let app_for_delay = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(120));
        let app_handle = app_for_delay.clone();
        let _ = app_for_delay.run_on_main_thread(move || {
            layout_main_window(&window_for_delay, &app_handle);
        });
    });
}

pub(crate) fn apply_responsive_window_size(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[window] main window not found");
        return;
    };

    schedule_main_window_layout(window, app.handle().clone());
}
