pub mod core;
pub mod file;
pub mod global_state;
pub mod hot_load_page;
pub mod http_services;
pub mod listen_key;
pub mod ocr;
pub mod plugin;
pub mod screenshot;
pub mod scroll_screenshot;
pub mod video_record;
pub mod webview;

use snow_shot_app_services::listen_mouse_service;
use snow_shot_tauri_commands_core::{FullScreenDrawWindowLabels, VideoRecordWindowLabels};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Mutex;

use tauri::Manager;

use snow_shot_app_os::ui_automation::UIElements;
use snow_shot_app_scroll_screenshot_service::scroll_screenshot_capture_service;
use snow_shot_app_scroll_screenshot_service::scroll_screenshot_image_service;
use snow_shot_app_scroll_screenshot_service::scroll_screenshot_service;
use snow_shot_app_services::file_cache_service;
use snow_shot_app_services::free_drag_window_service;
use snow_shot_app_services::hot_load_page_service;
use snow_shot_app_services::listen_key_service;
use snow_shot_app_services::ocr_service::OcrService;
use snow_shot_app_services::resize_window_service;
use snow_shot_app_services::video_record_service;
use snow_shot_app_shared::EnigoManager;
use snow_shot_global_state::{CaptureState, ReadClipboardState, WebViewSharedBufferState};
use serde::{Deserialize, Serialize};
use snow_shot_plugin_service::plugin_service;

/// 主窗口几何信息（outer size / outer position）。
///
/// 用 outer 而非 inner，避免无边框窗口（`set_decorations(false)` 自定义标题栏）
/// 下 inner/outer 不一致导致恢复出的尺寸比例失真（重启后变成方形/高度异常）。
#[derive(Serialize, Deserialize, Default, Clone)]
struct MainWindowGeometry {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

/// 是否记住关闭时的窗口位置和大小（由前端设置开关控制）。
static REMEMBER_WINDOW_GEOMETRY: std::sync::OnceLock<std::sync::Mutex<bool>> =
    std::sync::OnceLock::new();

fn remember_window_geometry_enabled() -> bool {
    *REMEMBER_WINDOW_GEOMETRY
        .get_or_init(|| std::sync::Mutex::new(true))
        .lock()
        .unwrap()
}

fn set_remember_window_geometry_enabled(enabled: bool) {
    *REMEMBER_WINDOW_GEOMETRY
        .get_or_init(|| std::sync::Mutex::new(true))
        .lock()
        .unwrap() = enabled;
}

/// 读取主窗口当前 outer 尺寸/位置并落盘。
fn save_main_window_geometry(app: &tauri::AppHandle) {
    // 开关关闭时不保存，确保关闭软件后下次启动恢复默认尺寸/位置
    if !remember_window_geometry_enabled() {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // 最小化时 outer 尺寸/位置是系统占位值（如 Windows 的 -32000），
    // 此时保存会把窗口“丢”到屏幕外，应跳过，保留上一次正常几何
    if matches!(window.is_minimized(), Ok(true)) {
        return;
    }
    let (size, pos) = match (window.outer_size(), window.outer_position()) {
        (Ok(s), Ok(p)) => (s, p),
        _ => return,
    };
    // 兜底校验：过滤异常几何（最小化残留、拖出屏幕外等）
    if size.width < 10 || size.height < 10 || pos.x < 0 || pos.y < 0 {
        return;
    }
    let geo = MainWindowGeometry {
        width: size.width,
        height: size.height,
        x: pos.x,
        y: pos.y,
    };
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(content) = serde_json::to_string(&geo) {
            let _ = std::fs::write(dir.join("main-window-geometry.json"), content);
        }
    }
}

/// 恢复主窗口上一次保存的尺寸/位置（在 setup 阶段、decorations 确定后调用）。
fn restore_main_window_geometry(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let Ok(content) = std::fs::read_to_string(dir.join("main-window-geometry.json")) else {
        return;
    };
    let Ok(geo) = serde_json::from_str::<MainWindowGeometry>(&content) else {
        return;
    };
    if geo.width >= 10 && geo.height >= 10 && geo.x >= 0 && geo.y >= 0 {
        let _ = window.set_size(tauri::PhysicalSize::new(geo.width, geo.height));
        let _ = window.set_position(tauri::PhysicalPosition::new(geo.x, geo.y));
    }
}

/// 前端开关「记住关闭时窗口的位置和大小」变化时调用。
/// 关闭时删除已保存的几何文件，使下次启动恢复默认。
#[tauri::command]
fn set_remember_window_geometry(app: tauri::AppHandle, remember: Option<bool>) {
	// 前端旧配置/未加载时可能传入 undefined，JSON 序列化后该 key 被丢弃，
	// 这里回退到默认 true，避免命令因缺少必需参数而报错。
	let remember = remember.unwrap_or(true);
	set_remember_window_geometry_enabled(remember);
	if !remember {
		if let Ok(dir) = app.path().app_config_dir() {
			let _ = std::fs::remove_file(dir.join("main-window-geometry.json"));
		}
	}
}

#[cfg(feature = "dhat-heap")]
pub static PROFILER: std::sync::LazyLock<Mutex<Option<dhat::Profiler>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ocr_instance = Mutex::new(OcrService::new());
    let video_record_service = Mutex::new(video_record_service::VideoRecordService::new());
    let hot_load_page_service = Arc::new(hot_load_page_service::HotLoadPageService::new());
    let enigo_instance = Mutex::new(EnigoManager::new());

    let ui_elements = Mutex::new(UIElements::new());

    let scroll_screenshot_service =
        Mutex::new(scroll_screenshot_service::ScrollScreenshotService::new());
    let scroll_screenshot_image_service =
        Mutex::new(scroll_screenshot_image_service::ScrollScreenshotImageService::new());
    let scroll_screenshot_capture_service =
        Mutex::new(scroll_screenshot_capture_service::ScrollScreenshotCaptureService::new());
    #[cfg(target_os = "windows")]
    let shared_buffer_service = Arc::new(snow_shot_webview::SharedBufferService::new());

    let free_drag_window_service =
        Mutex::new(free_drag_window_service::FreeDragWindowService::new());
    let resize_window_service = Mutex::new(resize_window_service::ResizeWindowService::new());

    let listen_key_service = Mutex::new(listen_key_service::ListenKeyService::new());
    let listen_mouse_service = Mutex::new(listen_mouse_service::ListenMouseService::new());

    let file_cache_service = Arc::new(file_cache_service::FileCacheService::new());

	let enable_run_log = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(
		log::LevelFilter::Warn as u8,
	));
	let enable_run_log_clone = enable_run_log.clone();
	let enable_run_log_boot = enable_run_log.clone();

    let plugin_service = Arc::new(plugin_service::PluginService::new());

    let capture_state = Mutex::new(CaptureState { capturing: false });

    let full_screen_draw_window_labels = Mutex::new(Option::<FullScreenDrawWindowLabels>::None);
    let video_record_window_label = Mutex::new(Option::<VideoRecordWindowLabels>::None);

    let webview_shared_buffer_state = WebViewSharedBufferState::new(false);

    let read_clipboard_state = Mutex::new(ReadClipboardState { reading: false });

    use tauri_plugin_log::{Target, TargetKind};

    // 每次启动用时间戳生成独立日志文件名
    let launch_tag = utc_timestamp_tag();
    let log_file_name = format!("snow-shot-{launch_tag}");

    // log 文件可能因为某些异常情况不断输出，造成日志文件过大
    // 先在 release 下屏蔽日志输出
    // 注意不要移除 log 插件的初始化,避免前端调用 log 时保存再次报错,持续循环报错
    let log_targets: Vec<Target> = if cfg!(debug_assertions) {
        vec![
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some(log_file_name.clone()),
            }),
            Target::new(TargetKind::Webview),
        ]
    } else {
        vec![Target::new(TargetKind::LogDir {
            file_name: Some(log_file_name),
        })]
    };
    // 将插件基础级别设为最详细，由下方 filter 根据用户选择的运行日志级别进行实际过滤
    let log_level = log::LevelFilter::Trace;

    #[allow(unused_mut)]
    let mut app_builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let app_window = app.get_webview_window("main").expect("no main window");
            app_window.show().unwrap();
            app_window.unminimize().unwrap();
            app_window.set_focus().unwrap();
        }))
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--auto_start"]),
        ))
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .targets(log_targets)
                .level(log_level)
                .filter(move |metadata| {
                    // 屏蔽 xcap 在枚举窗口时，对某些系统/受保护进程
                    // 调用 GetFileVersionInfoSizeW / GetModuleBaseNameW 失败产生的无害 ERROR 日志。
                    // 错误码 1813（无版本资源）与 5（拒绝访问）属于 Windows 上枚举窗口时的正常情况，
                    // xcap 会忽略并继续枚举，不影响截图与窗口识别功能，仅会产生日志噪音。
                    if metadata.target() == "xcap::platform::impl_window"
                        && metadata.level() == log::Level::Error
                    {
                        return false;
                    }

                    #[cfg(debug_assertions)]
                    {
                        return true;
                    }

				#[cfg(not(debug_assertions))]
				{
				let level = match enable_run_log.load(std::sync::atomic::Ordering::Relaxed) {
					0 => log::LevelFilter::Off,
					1 => log::LevelFilter::Error,
					2 => log::LevelFilter::Warn,
					3 => log::LevelFilter::Info,
					4 => log::LevelFilter::Debug,
					_ => log::LevelFilter::Trace,
				};

					return metadata.level() <= level;
				}
                })
                .build(),
        )
        .setup(move |app| {
            // 启动前先读取用户持久化的「运行日志」级别
            let run_log_level = read_run_log_setting(app);
            enable_run_log_boot.store(run_log_level as u8, std::sync::atomic::Ordering::Relaxed);

            // 软件启动 info 日志：记录版本、平台与架构，便于排查环境相关问题。
            log::info!(
                "[startup] Snow Shot 启动 | 版本: {} | 平台: {} | 架构: {} | 调试模式: {}",
                app.config().version.as_deref().unwrap_or("unknown"),
                std::env::consts::OS,
                std::env::consts::ARCH,
                cfg!(debug_assertions)
            );

            let main_window = app
                .get_webview_window("main")
                .expect("[lib::setup] no main window");

            #[cfg(target_os = "windows")]
            {
                match main_window.set_decorations(false) {
                    Ok(_) => (),
                    Err(_) => {
                        log::error!("[init_main_window] Failed to set decorations");
                    }
                }
            }

            #[cfg(target_os = "macos")]
            {
                // macOS 下不在 dock 显示。
                // 必须用 Accessory 而非 Prohibited：全局快捷键回调跑在主窗口 webview 的 JS 里，
                // 主窗口默认隐藏(visible:false)，只有 Accessory 这种后台 agent 策略才能让
                // 应用在窗口隐藏时仍保持活跃、隐藏 webview 的 JS 持续运行，快捷键才会触发。
                // Prohibited 会让应用无法被激活、隐藏 webview 被挂起，导致快捷键失效。
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            // 恢复主窗口上一次保存的大小和位置（outer size/position，在 decorations 确定后）
            restore_main_window_geometry(app.handle());

            // 监听窗口关闭事件，拦截关闭按钮
            let window_clone = main_window.clone();
            let app_handle_for_geo = app.handle().clone();
            main_window.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        save_main_window_geometry(&app_handle_for_geo);

                        #[cfg(target_os = "windows")]
                        {
                            if let Err(e) = window_clone.hide() {
                                log::error!("[setup] hide window error: {:?}", e);
                            }
                        }

                        #[cfg(target_os = "macos")]
                        {
                            if let Err(e) = window_clone.hide() {
                                log::error!("[setup] hide window error: {:?}", e);
                            }
                        }

                        window_clone.emit("on-hide-main-window", ()).unwrap();
                    }
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                        save_main_window_geometry(&app_handle_for_geo);
                    }
                    _ => {}
                }
            });

            // 如果是调试模式，则显示窗口
            #[cfg(debug_assertions)]
            {
                main_window.show().unwrap();
            }

            Ok(())
        })
        .manage(ui_elements)
        .manage(ocr_instance)
        .manage(enigo_instance)
        .manage(scroll_screenshot_service)
        .manage(scroll_screenshot_image_service)
        .manage(scroll_screenshot_capture_service)
        .manage(video_record_service)
        .manage(free_drag_window_service)
        .manage(resize_window_service)
        .manage(listen_key_service)
        .manage(listen_mouse_service)
        .manage(file_cache_service)
        .manage(enable_run_log_clone)
        .manage(plugin_service)
        .manage(full_screen_draw_window_labels)
        .manage(webview_shared_buffer_state)
        .manage(hot_load_page_service)
        .manage(video_record_window_label)
        .manage(capture_state)
        .manage(read_clipboard_state)
        .invoke_handler(tauri::generate_handler![
            screenshot::capture_current_monitor,
            screenshot::capture_all_monitors,
            screenshot::capture_focused_window,
            screenshot::get_focused_window_app_name,
            screenshot::get_window_elements,
            screenshot::init_ui_elements,
            screenshot::get_element_from_position,
            screenshot::init_ui_elements_cache,
            screenshot::get_mouse_position,
            screenshot::create_draw_window,
            screenshot::switch_always_on_top,
            screenshot::set_draw_window_style,
            screenshot::capture_full_screen,
            file::save_file,
            file::write_file,
            file::copy_file,
            file::remove_file,
            file::create_dir,
            file::remove_dir,
            file::get_app_config_dir,
            file::get_app_config_base_dir,
            file::create_local_config_dir,
            ocr::ocr_detect,
            #[cfg(target_os = "windows")]
            ocr::ocr_detect_with_shared_buffer,
            ocr::ocr_init,
            ocr::ocr_release,
            ocr::list_ocr_model_files,
            core::exit_app,
            core::start_free_drag,
            core::start_resize_window,
            core::close_window_after_delay,
            core::get_selected_text,
            core::set_enable_proxy,
            core::scroll_through,
            core::auto_scroll_through,
            core::click_through,
            core::create_fixed_content_window,
            core::read_image_from_clipboard,
            core::create_full_screen_draw_window,
            core::close_full_screen_draw_window,
            core::get_current_monitor_info,
            core::get_monitors_bounding_box,
            core::send_new_version_notification,
            core::create_video_record_window,
            core::close_video_record_window,
            core::has_video_record_window,
            core::has_focused_full_screen_window,
            core::set_current_window_always_on_top,
            core::auto_start_enable,
            core::auto_start_disable,
            core::restart_with_admin,
            core::restart,
            core::write_bitmap_image_to_clipboard,
            #[cfg(target_os = "windows")]
            core::write_bitmap_image_to_clipboard_with_shared_buffer,
            core::retain_dir_files,
            core::is_admin,
            core::set_run_log,
            #[cfg(target_os = "windows")]
            core::set_process_priority,
            core::set_exclude_from_capture,
            core::show_main_window,
            core::set_window_rect,
            core::get_commit_sha,
            set_remember_window_geometry,
            scroll_screenshot::scroll_screenshot_get_image_data,
            scroll_screenshot::scroll_screenshot_init,
            scroll_screenshot::scroll_screenshot_capture,
            scroll_screenshot::scroll_screenshot_handle_image,
            scroll_screenshot::scroll_screenshot_save_to_file,
            scroll_screenshot::scroll_screenshot_save_to_clipboard,
            scroll_screenshot::scroll_screenshot_get_size,
            scroll_screenshot::scroll_screenshot_clear,
            video_record::video_record_start,
            video_record::video_record_stop,
            video_record::video_record_pause,
            video_record::video_record_resume,
            video_record::video_record_kill,
            video_record::video_record_get_microphone_device_names,
            video_record::video_record_init,
            listen_key::listen_key_start,
            listen_key::listen_key_stop,
            listen_key::listen_key_stop_by_window_label,
            listen_key::listen_mouse_start,
            listen_key::listen_mouse_stop,
            listen_key::listen_mouse_stop_by_window_label,
            file::text_file_read,
            file::text_file_write,
            file::text_file_clear,
            file::is_portable_app,
            plugin::plugin_init,
            plugin::plugin_get_plugins_status,
            plugin::plugin_register_plugin,
            plugin::plugin_install_plugin,
            plugin::plugin_uninstall_plugin,
            webview::create_webview_shared_buffer,
            webview::set_support_webview_shared_buffer,
            #[cfg(target_os = "windows")]
            webview::create_webview_shared_buffer_channel,
            #[cfg(target_os = "windows")]
            core::write_image_pixels_to_clipboard_with_shared_buffer,
            http_services::upload_to_s3,
            hot_load_page::hot_load_page_init,
            hot_load_page::hot_load_page_add_page,
            global_state::set_capture_state,
            global_state::get_capture_state,
            global_state::set_read_clipboard_state,
            global_state::get_read_clipboard_state,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let window_label = window.label().to_owned();

                // 用 tokio 异步进程实现清除有异步所有权问题，通知前端清理，简单处理
                match window
                    .app_handle()
                    .emit("listen-key-service:stop", window_label.clone())
                {
                    Ok(_) => (),
                    Err(e) => {
                        log::error!("[listen_key_service:stop] Failed to emit event: {}", e);
                    }
                }
                match window
                    .app_handle()
                    .emit("listen-mouse-service:stop", window_label.clone())
                {
                    Ok(_) => (),
                    Err(e) => {
                        log::error!("[listen_mouse_service:stop] Failed to emit event: {}", e);
                    }
                }
            }
        });

    #[cfg(target_os = "windows")]
    {
        app_builder = app_builder.manage(shared_buffer_service);
    }

    let app = app_builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app, event| {
        // 应用退出时持久化主窗口几何信息，确保即使未触发关闭按钮也能保存
        if let tauri::RunEvent::Exit = event {
            save_main_window_geometry(app);
        }
    });
}

/// 读取持久化的「运行日志」级别。
fn read_run_log_setting(app: &tauri::App) -> log::LevelFilter {
    let file_cache = app.state::<Arc<file_cache_service::FileCacheService>>();
    let config_dir = match file_cache.get_app_config_dir(app.handle()) {
        Ok(dir) => dir,
        Err(_) => return log::LevelFilter::Warn,
    };

    let path = config_dir.join("systemCommon.json");
    let content = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return log::LevelFilter::Warn,
    };

    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => return log::LevelFilter::Warn,
    };

    match value.get("runLog").and_then(|value| value.as_str()) {
        Some(level) => map_run_log_str(level),
        None => log::LevelFilter::Warn,
    }
}

/// 将 runLog 字符串映射为 log 级别；未知值回退 Warn。
fn map_run_log_str(level: &str) -> log::LevelFilter {
    match level {
        "off" => log::LevelFilter::Off,
        "error" => log::LevelFilter::Error,
        "warn" => log::LevelFilter::Warn,
        "info" => log::LevelFilter::Info,
        "debug" => log::LevelFilter::Debug,
        "trace" => log::LevelFilter::Trace,
        _ => log::LevelFilter::Warn,
    }
}

/// 使用标准库生成 `YYYY-MM-DD_HH-MM-SS` 形式的时间戳（UTC），
/// 用于日志文件名，避免引入额外的日期时间依赖。
fn utc_timestamp_tag() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let days = secs / 86_400;
    let rem = secs % 86_400;
    let hour = (rem / 3_600) as u32;
    let min = ((rem % 3_600) / 60) as u32;
    let sec = (rem % 60) as u32;

    // 从 1970-01-01 起推算年/月/日（UTC）
    let mut year: i64 = 1970;
    let mut d = days as i64;
    loop {
        let ydays = if is_leap_year(year) { 366 } else { 365 };
        if d < ydays {
            break;
        }
        d -= ydays;
        year += 1;
    }

    let month_days = month_lengths(year);
    let mut month = 0usize;
    let mut day = d;
    while day >= month_days[month] {
        day -= month_days[month];
        month += 1;
    }

    format!(
        "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
        year,
        month + 1,
        day + 1,
        hour,
        min,
        sec
    )
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn month_lengths(year: i64) -> [i64; 12] {
    [
        31,
        if is_leap_year(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ]
}
