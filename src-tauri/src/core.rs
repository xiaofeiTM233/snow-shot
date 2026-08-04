use snow_shot_app_shared::{ElementRect, EnigoManager};
use snow_shot_global_state::WebViewSharedBufferState;
use snow_shot_tauri_commands_core::{
    FullScreenDrawWindowLabels, MonitorsBoundingBox, VideoRecordWindowLabels,
};
use std::{path::PathBuf, sync::Arc};
use tauri::{Manager, PhysicalPosition, PhysicalSize, command, ipc::Response};
use tauri_plugin_autostart::ManagerExt;
use tokio::sync::Mutex;

#[command]
pub async fn exit_app(handle: tauri::AppHandle) {
    #[cfg(feature = "dhat-heap")]
    drop(crate::PROFILER.lock().await.take());

    snow_shot_tauri_commands_core::exit_app(handle).await;
}

#[command]
pub async fn get_selected_text() -> String {
    let mut text = snow_shot_tauri_commands_core::get_selected_text().await;
    if text.is_empty() {
        tokio::time::sleep(tokio::time::Duration::from_millis(83)).await;
        text = snow_shot_tauri_commands_core::get_selected_text().await;
    }

    text
}

#[command]
pub async fn set_enable_proxy(enable: bool, host: String) -> Result<(), ()> {
    snow_shot_tauri_commands_core::set_enable_proxy(enable, host).await
}

/// 鼠标滚轮穿透
#[command]
pub async fn scroll_through(
    window: tauri::Window,
    enigo_manager: tauri::State<'_, Mutex<EnigoManager>>,
    length: i32,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::scroll_through(window, enigo_manager, length).await
}

/// 鼠标滚轮穿透
#[command]
pub async fn auto_scroll_through(
    enigo_manager: tauri::State<'_, Mutex<EnigoManager>>,
    direction: String,
    length: i32,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::auto_scroll_through(enigo_manager, direction, length).await
}

/// 鼠标滚轮穿透
#[command]
pub async fn click_through(window: tauri::Window) -> Result<(), ()> {
    snow_shot_tauri_commands_core::click_through(window).await
}

/// 创建内容固定到屏幕的窗口
#[command]
pub async fn create_fixed_content_window(
    app: tauri::AppHandle,
    hot_load_page_service: tauri::State<
        '_,
        Arc<snow_shot_app_services::hot_load_page_service::HotLoadPageService>,
    >,
    scroll_screenshot: bool,
    file_path: Option<String>,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::create_fixed_content_window(
        app,
        hot_load_page_service,
        scroll_screenshot,
        file_path,
    )
    .await
}

#[command]
pub async fn read_image_from_clipboard(
    handle: tauri::AppHandle,
    #[allow(unused_variables)] webview_shared_buffer_state: tauri::State<
        '_,
        WebViewSharedBufferState,
    >,
    #[allow(unused_variables)] webview: tauri::Webview,
) -> Result<Response, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;

        if *webview_shared_buffer_state.enable.read().await {
            let image_data = match handle.clipboard().read_image() {
                Ok(image) => image,
                Err(_) => {
                    return Ok(Response::new(Vec::new()));
                }
            };

            let mut extra_data = vec![0; 8];
            unsafe {
                let image_width = image_data.width();
                let image_height = image_data.height();
                std::ptr::copy_nonoverlapping(
                    image_width.to_le_bytes().as_ptr(),
                    extra_data.as_mut_ptr(),
                    4,
                );
                std::ptr::copy_nonoverlapping(
                    image_height.to_le_bytes().as_ptr(),
                    extra_data.as_mut_ptr().add(4),
                    4,
                );
            }

            snow_shot_webview::create_shared_buffer(
                webview,
                image_data.rgba(),
                &extra_data,
                "read_image_from_clipboard".to_string(),
            )
            .await?;

            return Ok(Response::new(vec![1]));
        }
    }

    let clipboard = handle.state::<tauri_plugin_clipboard::Clipboard>();
    let image_data = match tauri_plugin_clipboard::Clipboard::read_image_binary(&clipboard) {
        Ok(image_data) => image_data,
        Err(_) => return Ok(Response::new(Vec::new())),
    };

    return Ok(Response::new(image_data));
}

/// 创建全屏绘制窗口
#[command]
pub async fn create_full_screen_draw_window(
    app: tauri::AppHandle,
    full_screen_draw_window_labels: tauri::State<'_, Mutex<Option<FullScreenDrawWindowLabels>>>,
    hot_load_page_service: tauri::State<
        '_,
        Arc<snow_shot_app_services::hot_load_page_service::HotLoadPageService>,
    >,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::create_full_screen_draw_window(
        app,
        full_screen_draw_window_labels,
        hot_load_page_service,
    )
    .await
}

#[command]
pub async fn close_full_screen_draw_window(
    app: tauri::AppHandle,
    full_screen_draw_window_labels: tauri::State<'_, Mutex<Option<FullScreenDrawWindowLabels>>>,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::close_full_screen_draw_window(
        app,
        full_screen_draw_window_labels,
    )
    .await
}

#[command]
pub async fn get_current_monitor_info() -> Result<snow_shot_tauri_commands_core::MonitorInfo, String>
{
    snow_shot_tauri_commands_core::get_current_monitor_info().await
}

#[command]
pub async fn get_monitors_bounding_box(
    app: tauri::AppHandle,
    region: Option<ElementRect>,
    enable_multiple_monitor: bool,
) -> Result<MonitorsBoundingBox, String> {
    snow_shot_tauri_commands_core::get_monitors_bounding_box(&app, region, enable_multiple_monitor)
        .await
}

#[command]
pub async fn send_new_version_notification(title: String, body: String) {
    snow_shot_tauri_commands_core::send_new_version_notification(title, body).await;
}

/// 创建屏幕录制窗口
#[command]
pub async fn create_video_record_window(
    app: tauri::AppHandle,
    video_record_window_label: tauri::State<'_, Mutex<Option<VideoRecordWindowLabels>>>,
    hot_load_page_service: tauri::State<
        '_,
        Arc<snow_shot_app_services::hot_load_page_service::HotLoadPageService>,
    >,
    select_rect_min_x: i32,
    select_rect_min_y: i32,
    select_rect_max_x: i32,
    select_rect_max_y: i32,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::create_video_record_window(
        app,
        video_record_window_label,
        hot_load_page_service,
        select_rect_min_x,
        select_rect_min_y,
        select_rect_max_x,
        select_rect_max_y,
    )
    .await;
    Ok(())
}

#[command]
pub async fn close_video_record_window(
    app: tauri::AppHandle,
    video_record_window_label: tauri::State<'_, Mutex<Option<VideoRecordWindowLabels>>>,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::close_video_record_window(app, video_record_window_label).await
}

#[command]
pub async fn has_video_record_window(
    video_record_window_labels: tauri::State<'_, Mutex<Option<VideoRecordWindowLabels>>>,
) -> Result<bool, String> {
    snow_shot_tauri_commands_core::has_video_record_window(video_record_window_labels).await
}

#[command]
pub async fn start_free_drag(
    window: tauri::Window,
    free_drag_window_service: tauri::State<
        '_,
        Mutex<snow_shot_app_services::free_drag_window_service::FreeDragWindowService>,
    >,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::start_free_drag(window, free_drag_window_service).await
}

#[command]
pub async fn start_resize_window(
    window: tauri::Window,
    resize_window_service: tauri::State<
        '_,
        Mutex<snow_shot_app_services::resize_window_service::ResizeWindowService>,
    >,
    side: snow_shot_app_services::resize_window_service::ResizeWindowSide,
    spect_ratio: f64,
    min_width: f64,
    max_width: f64,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::start_resize_window(
        window,
        resize_window_service,
        side,
        spect_ratio,
        min_width,
        max_width,
    )
    .await
}

#[command]
pub async fn set_current_window_always_on_top(
    window: tauri::WebviewWindow,
    allow_input_method_overlay: bool,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::set_current_window_always_on_top(
        window,
        allow_input_method_overlay,
    )
    .await
}

#[command]
pub async fn close_window_after_delay(window: tauri::Window, delay: u64) {
    snow_shot_tauri_commands_core::close_window_after_delay(window, delay).await
}

#[command]
pub async fn auto_start_enable(app: tauri::AppHandle) -> Result<(), String> {
    let autostart_manager = app.autolaunch();

    #[cfg(not(target_os = "windows"))]
    {
        return match autostart_manager.enable() {
            Ok(_) => Ok(()),
            Err(e) => Err(format!(
                "[auto_start_enable] Failed to enable autostart: {}",
                e,
            )),
        };
    }

    #[cfg(target_os = "windows")]
    {
        // 判断是否是管理员模式
        let is_admin = match snow_shot_tauri_commands_core::is_admin().await {
            Ok(is_admin) => is_admin,
            Err(_) => return Err(String::from("[auto_start_enable] Failed to check if admin")),
        };

        // 如果是管理员模式，则禁用普通的自启动方式，使用 Windows 的任务计划程序实现自启动
        if !is_admin {
            match autostart_manager.enable() {
                Ok(_) => (),
                Err(e) => {
                    return Err(format!(
                        "[auto_start_enable] Failed to enable autostart: {}",
                        e,
                    ));
                }
            }

            return Ok(());
        }

        // 禁用普通自启动方式
        // 仅当普通自启动已启用时才禁用，避免自启动项不存在时报 "系统找不到指定的文件" (os error 2)
        match autostart_manager.is_enabled() {
            Ok(true) => match autostart_manager.disable() {
                Ok(_) => (),
                Err(e) => {
                    // 如果 autostart_manager 不是设置了的状态，则可能报错
                    // 所以不提前退出
                    log::warn!("[auto_start_enable] Failed to disable autostart: {}", e);
                }
            },
            Ok(false) => (),
            Err(e) => {
                log::warn!("[auto_start_enable] Failed to check autostart status: {}", e);
            }
        }

        // 创建管理员自启动任务
        match snow_shot_tauri_commands_core::create_admin_auto_start_task().await {
            Ok(_) => (),
            Err(e) => {
                return Err(format!(
                    "[auto_start_enable] Failed to create admin auto start task: {}",
                    e,
                ));
            }
        }

        Ok(())
    }
}

#[command]
pub async fn auto_start_disable(app: tauri::AppHandle) -> Result<(), String> {
    let autostart_manager = app.autolaunch();

    // 先禁用普通自启动方式
    // 仅当普通自启动已启用时才禁用，避免自启动项不存在时报 "系统找不到指定的文件" (os error 2)
    match autostart_manager.is_enabled() {
        Ok(true) => match autostart_manager.disable() {
            Ok(_) => (),
            Err(e) => {
                log::warn!("[auto_start_disable] Failed to disable autostart: {}", e);
            }
        },
        Ok(false) => (),
        Err(e) => {
            log::warn!("[auto_start_disable] Failed to check autostart status: {}", e);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // 判断是否是管理员模式
        let is_admin = match snow_shot_tauri_commands_core::is_admin().await {
            Ok(is_admin) => is_admin,
            Err(_) => {
                return Err(String::from(
                    "[auto_start_disable] Failed to check if admin",
                ));
            }
        };

        if !is_admin {
            return Ok(());
        }

        // 删除管理员自启动任务
        match snow_shot_tauri_commands_core::delete_admin_auto_start_task().await {
            Ok(_) => (),
            Err(e) => {
                return Err(format!(
                    "[auto_start_disable] Failed to delete admin auto start task: {}",
                    e,
                ));
            }
        }

        Ok(())
    }
}

#[command]
pub async fn restart_with_admin() -> Result<(), String> {
    snow_shot_tauri_commands_core::restart_with_admin().await
}

#[command]
pub async fn restart() -> Result<(), String> {
    snow_shot_tauri_commands_core::restart().await
}

#[command]
pub async fn write_bitmap_image_to_clipboard(
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::write_bitmap_image_to_clipboard(request).await
}

#[cfg(target_os = "windows")]
#[command]
pub async fn write_bitmap_image_to_clipboard_with_shared_buffer(
    shared_buffer_service: tauri::State<'_, Arc<snow_shot_webview::SharedBufferService>>,
    channel_id: String,
) -> Result<(), String> {
    snow_shot_app_utils::write_bitmap_image_to_clipboard_with_shared_buffer(
        shared_buffer_service,
        channel_id,
    )
    .await
}

#[command]
pub async fn retain_dir_files(dir_path: PathBuf, file_names: Vec<String>) -> Result<(), String> {
    snow_shot_tauri_commands_core::retain_dir_files(dir_path, file_names).await
}

#[command]
pub async fn is_admin() -> Result<bool, String> {
    snow_shot_tauri_commands_core::is_admin().await
}

#[cfg(target_os = "windows")]
#[command]
pub async fn set_process_priority(enable: bool) -> Result<(), String> {
    snow_shot_tauri_commands_core::set_process_priority(enable).await
}

#[command]
pub async fn set_run_log(
    enable_run_log: tauri::State<'_, std::sync::Arc<std::sync::atomic::AtomicU8>>,
    level: String,
) -> Result<(), String> {
    let level_filter = match level.as_str() {
        "off" => log::LevelFilter::Off,
        "error" => log::LevelFilter::Error,
        "warn" => log::LevelFilter::Warn,
        "info" => log::LevelFilter::Info,
        "debug" => log::LevelFilter::Debug,
        "trace" => log::LevelFilter::Trace,
        _ => return Err(format!("未知的日志级别: {level}")),
    };

    enable_run_log.store(level_filter as u8, std::sync::atomic::Ordering::Relaxed);

    Ok(())
}

/// 根据当前日志保留时长设置清理过期的日志文件。
#[command]
pub async fn cleanup_logs_by_retention(app: tauri::AppHandle) -> Result<(), String> {
    crate::cleanup_old_logs(&app);
    Ok(())
}

#[command]
pub async fn set_exclude_from_capture(window: tauri::Window, enable: bool) -> Result<(), String> {
    snow_shot_app_utils::set_exclude_from_capture(&window, enable).await
}

#[cfg(target_os = "windows")]
#[command]
pub async fn write_image_pixels_to_clipboard_with_shared_buffer(
    app: tauri::AppHandle,
    shared_buffer_service: tauri::State<'_, Arc<snow_shot_webview::SharedBufferService>>,
    channel_id: String,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::write_image_pixels_to_clipboard_with_shared_buffer(
        app,
        shared_buffer_service,
        channel_id,
    )
    .await
}

#[command]
pub async fn has_focused_full_screen_window() -> Result<bool, String> {
    snow_shot_tauri_commands_core::has_focused_full_screen_window().await
}

#[command]
pub async fn show_main_window(app: tauri::AppHandle, auto_hide: bool) -> Result<(), String> {
    snow_shot_tauri_commands_core::show_main_window(app, auto_hide).await
}

#[command]
pub async fn set_window_rect(
    window: tauri::Window,
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
) -> Result<(), String> {
    match window.set_size(PhysicalSize::new(max_x - min_x, max_y - min_y)) {
        Ok(_) => (),
        Err(e) => {
            return Err(format!(
                "[set_window_rect] Failed to set window size: {}",
                e
            ));
        }
    }
    match window.set_position(PhysicalPosition::new(min_x, min_y)) {
        Ok(_) => (),
        Err(e) => {
            return Err(format!(
                "[set_window_rect] Failed to set window position: {}",
                e
            ));
        }
    }

    Ok(())
}

#[command]
pub async fn get_commit_sha() -> String {
    option_env!("COMMIT_SHA").unwrap_or("unknown").to_string()
}
