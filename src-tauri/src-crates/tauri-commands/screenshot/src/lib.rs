use image::DynamicImage;
use serde::Serialize;
use snow_shot_app_os::ui_automation::UIElements;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
use snow_shot_app_shared::ElementRect;
use snow_shot_app_utils::monitor_info::{
    CaptureMethod, CaptureOption, ColorFormat, CorrectHdrColorAlgorithm, MonitorList,
};
use snow_shot_global_state::WebViewSharedBufferState;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::Response;
use tokio::sync::Mutex;

pub async fn capture_current_monitor(
    #[allow(unused_variables)] window: tauri::Window,
    encoder: String,
) -> Result<Response, String> {
    // 获取当前鼠标的位置
    let (_, _, monitor) = snow_shot_app_utils::get_target_monitor()?;

    let image_buffer = match snow_shot_app_utils::capture_target_monitor(
        &monitor,
        None,
        Some(&window),
        ColorFormat::Rgb8,
    ) {
        Some(image) => image,
        None => {
            log::error!("Failed to capture current monitor");
            return Ok(Response::new(Vec::new()));
        }
    };

    let image_buffer = snow_shot_app_utils::encode_image(
        &image_buffer,
        match encoder.as_str() {
            "webp" => snow_shot_app_utils::ImageEncoder::Webp,
            "png" => snow_shot_app_utils::ImageEncoder::Png,
            _ => snow_shot_app_utils::ImageEncoder::Webp,
        },
    )
    .map_err(|e| e.to_string())?;

    Ok(Response::new(image_buffer))
}

pub async fn capture_all_monitors(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    #[allow(unused_variables)] webview: tauri::Webview,
    #[allow(unused_variables)] webview_shared_buffer_state: tauri::State<
        '_,
        WebViewSharedBufferState,
    >,
    enable_multiple_monitor: bool,
    correct_hdr_color_algorithm: CorrectHdrColorAlgorithm,
    correct_color_filter: bool,
    capture_method: CaptureMethod,
) -> Result<Response, String> {
    #[cfg(target_os = "macos")]
    {
        let image = snow_shot_app_utils::get_capture_monitor_list(
            &app_handle,
            None,
            enable_multiple_monitor,
            true,
        )?
        .capture(
            Some(&window),
            CaptureOption {
                color_format: ColorFormat::Rgb8,
                correct_hdr_color_algorithm,
                correct_color_filter,
                capture_method,
            },
        )
        .await?;

        let image_buffer = snow_shot_app_utils::encode_image(&image, snow_shot_app_utils::ImageEncoder::Png)
            .map_err(|e| e.to_string())?;

        Ok(Response::new(image_buffer))
    }

    #[cfg(target_os = "windows")]
    {
        let image = snow_shot_app_utils::get_capture_monitor_list(
            &app_handle,
            None,
            enable_multiple_monitor,
            correct_hdr_color_algorithm == CorrectHdrColorAlgorithm::None,
        )?
        .capture(
            Some(&window),
            CaptureOption {
                color_format: ColorFormat::Rgba8,
                correct_hdr_color_algorithm,
                correct_color_filter,
                capture_method,
            },
        )
        .await?;

        if *webview_shared_buffer_state.enable.read().await {
            let mut extra_data = vec![0; 8];
            unsafe {
                let image_width = image.width();
                let image_height = image.height();
                std::ptr::copy_nonoverlapping(
                    &image_width as *const u32 as *const u8,
                    extra_data.as_mut_ptr(),
                    4,
                );
                std::ptr::copy_nonoverlapping(
                    &image_height as *const u32 as *const u8,
                    extra_data.as_mut_ptr().add(4),
                    4,
                );
            }

            snow_shot_webview::create_shared_buffer(
                webview,
                image.as_bytes(),
                &extra_data,
                "screenshot".to_string(),
            )
            .await?;

            // 通过 SharedBuffer 传输的特殊标记
            Ok(Response::new(vec![1]))
        } else {
            let image_buffer = snow_shot_app_utils::encode_image(&image, snow_shot_app_utils::ImageEncoder::Png)
                .map_err(|e| e.to_string())?;

            Ok(Response::new(image_buffer))
        }
    }
}

#[cfg(target_os = "windows")]
pub fn capture_window_hdr_image(
    hwnd: HWND,
    algorithm: CorrectHdrColorAlgorithm,
) -> Option<image::DynamicImage> {
    use snow_shot_app_utils::monitor_hdr_info::get_all_monitors_sdr_info;
    use snow_shot_app_utils::monitor_info::MonitorInfo;
    use snow_shot_app_utils::windows_capture_image;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
    };

    // 获取窗口所属的显示器
    let hmonitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if hmonitor.is_invalid() {
        return None;
    }

    // 取得显示器设备名（与 monitor_hdr_info 的 key 一致，形如 \\.\DISPLAYx）
    let mut monitor_info = MONITORINFOEXW {
        monitorInfo: windows::Win32::Graphics::Gdi::MONITORINFO {
            cbSize: u32::try_from(std::mem::size_of::<MONITORINFOEXW>()).unwrap(),
            rcMonitor: windows::Win32::Foundation::RECT::default(),
            rcWork: windows::Win32::Foundation::RECT::default(),
            dwFlags: 0,
        },
        szDevice: [0; 32],
    };
    if !unsafe { GetMonitorInfoW(hmonitor, std::ptr::addr_of_mut!(monitor_info).cast()) }.as_bool() {
        return None;
    }
    let device_name = String::from_utf16_lossy(
        &monitor_info.szDevice[..monitor_info.szDevice.iter().position(|&c| c == 0).unwrap_or(monitor_info.szDevice.len())],
    );

    let hdr_infos = match get_all_monitors_sdr_info() {
        Ok(hdr_infos) => hdr_infos,
        Err(e) => {
            log::error!(
                "[capture_window_hdr_image] Failed to get all monitors SDR info: {}",
                e
            );
            return None;
        }
    };

    let hdr_info = match hdr_infos.get(device_name.as_str()) {
        Some(hdr_info) => hdr_info,
        None => return None,
    };

    if !hdr_info.hdr_enabled {
        return None;
    }

    // 用设备名构造 xcap Monitor（经由 name 匹配的原生 HMONITOR），再交给 WGC 捕获。
    let monitor = match xcap::Monitor::all()
        .unwrap_or_default()
        .into_iter()
        .find(|m| m.name().unwrap_or_default() == device_name)
    {
        Some(monitor) => monitor,
        None => return None,
    };

    return match windows_capture_image::capture_monitor_image(
        &MonitorInfo::new(&monitor, Some(hdr_info.clone())),
        Some(hwnd),
        None,
        ColorFormat::Rgba8,
        algorithm,
    ) {
        Ok(image) => Some(image),
        Err(error) => {
            log::error!(
                "[capture_window_hdr_image] Failed to capture HDR window image: {}",
                error
            );
            None
        }
    };
}

pub async fn capture_focused_window(
    #[allow(unused_variables)] correct_hdr_color_algorithm: CorrectHdrColorAlgorithm,
    #[allow(unused_variables)] capture_method: CaptureMethod,
) -> Result<Response, String>
{
    let image;

    #[cfg(target_os = "windows")]
    {
        let hwnd = snow_shot_app_os::utils::get_focused_window();

        // 非 Xcap 模式尝试 WGC 的 HDR 窗口捕获，失败则由下方回退到 xcap。
        let hdr_image = if capture_method != CaptureMethod::Xcap {
            capture_window_hdr_image(hwnd, correct_hdr_color_algorithm)
        } else {
            None
        };

        image = match hdr_image {
            Some(image) => image,
            None => {
                // 用原生 HWND 反查 xcap Window，以便调用其 capture_image() 回退。
                let focused_window = xcap::Window::all()
                    .unwrap_or_default()
                    .into_iter()
                    .find(|w| {
                        snow_shot_app_utils::sys::windows::hwnd::find_window_hwnd(w) == Some(hwnd)
                    });

                match focused_window {
                    Some(window) => match window.capture_image() {
                        Ok(image) => DynamicImage::ImageRgba8(image),
                        Err(_) => {
                            log::warn!("[capture_focused_window] Failed to capture focused window");
                            fallback_to_monitor()?
                        }
                    },
                    None => {
                        log::warn!("[capture_focused_window] Failed to find focused window in xcap list");
                        fallback_to_monitor()?
                    }
                }
            }
        };
    }

    #[cfg(target_os = "linux")]
    {
        let (_, _, monitor) = snow_shot_app_utils::get_target_monitor();

        image = match monitor.capture_image() {
            Ok(image) => image,
            Err(_) => {
                return Err(String::from(
                    "[capture_focused_window] Failed to capture image",
                ));
            }
        };
    }

    #[cfg(target_os = "macos")]
    {
        let window_list = xcap::Window::all().unwrap_or_default();
        let window = window_list.iter().find(|w| {
            w.is_focused().unwrap_or(false)
                // 排除某些托盘应用，托盘应用会捕获到托盘图标
                && w.y().unwrap_or(0) != 0
                && !w.title().unwrap_or_default().starts_with("Item-")
        });

        let window_image = match window {
            Some(window) => match window.capture_image() {
                Ok(image) => Some(image),
                Err(_) => None,
            },
            None => None,
        };

        image = match window_image {
            Some(image) => DynamicImage::ImageRgba8(image),
            None => {
                log::warn!("[capture_focused_window] Failed to capture focused window");
                // 改成捕获当前显示器

                let (_, _, monitor) = snow_shot_app_utils::get_target_monitor()?;

                match monitor.capture_image() {
                    Ok(image) => DynamicImage::ImageRgba8(image),
                    Err(_) => {
                        return Err(String::from(
                            "[capture_focused_window] Failed to capture image",
                        ));
                    }
                }
            }
        };
    }

    // 编码图像为 PNG 格式并返回
    let image_buffer = snow_shot_app_utils::encode_image(&image, snow_shot_app_utils::ImageEncoder::Png)
        .map_err(|e| e.to_string())?;

    Ok(Response::new(image_buffer))
}

/// Windows 下捕获聚焦窗口失败时的回退：截取当前鼠标所在显示器。
#[cfg(target_os = "windows")]
fn fallback_to_monitor() -> Result<image::DynamicImage, String> {
    let (_, _, monitor) = snow_shot_app_utils::get_target_monitor()?;

    match monitor.capture_image() {
        Ok(image) => Ok(DynamicImage::ImageRgba8(image)),
        Err(_) => Err(String::from(
            "[capture_focused_window] Failed to capture image",
        )),
    }
}

/// 获取当前焦点窗口的应用名称
pub fn get_focused_window_app_name() -> String {
    #[cfg(target_os = "windows")]
    {
        let hwnd = snow_shot_app_os::utils::get_focused_window();
        let focused_window = xcap::Window::all()
            .unwrap_or_default()
            .into_iter()
            .find(|w| {
                snow_shot_app_utils::sys::windows::hwnd::find_window_hwnd(w) == Some(hwnd)
            });
        focused_window
            .and_then(|w| w.app_name().ok())
            .unwrap_or_default()
    }

    #[cfg(target_os = "linux")]
    {
        String::new()
    }

    #[cfg(target_os = "macos")]
    {
        let window_list = xcap::Window::all().unwrap_or_default();
        let window = window_list.iter().find(|w| {
            w.is_focused().unwrap_or(false)
                && w.y().unwrap_or(0) != 0
                && !w.title().unwrap_or_default().starts_with("Item-")
        });
        match window {
            Some(w) => w.app_name().unwrap_or_default(),
            None => String::new(),
        }
    }
}

pub async fn init_ui_elements(ui_elements: tauri::State<'_, Mutex<UIElements>>) -> Result<(), ()> {
    let mut ui_elements = ui_elements.lock().await;

    match ui_elements.init() {
        Ok(_) => Ok(()),
        Err(_) => Err(()),
    }
}

pub async fn init_ui_elements_cache(
    ui_elements: tauri::State<'_, Mutex<UIElements>>,
    #[allow(unused_variables)] blacklist: Option<Vec<String>>,
) -> Result<(), String> {
    let mut ui_elements = ui_elements.lock().await;

    ui_elements.init_cache().map_err(|e| format!("[init_ui_elements_cache] error: {:?}", e))?;

    #[cfg(target_os = "windows")]
    if let Some(blacklist) = blacklist {
        ui_elements.set_blacklist(&blacklist);
    }

    Ok(())
}

#[derive(PartialEq, Eq, Serialize, Clone, Debug, Copy, Hash)]
pub struct WindowElement {
    element_rect: ElementRect,
    window_id: u32,
}

pub async fn get_window_elements(
    #[allow(unused_variables)] window: tauri::Window,
    #[allow(unused_variables)] blacklist: Option<Vec<String>>,
) -> Result<Vec<WindowElement>, ()> {
    // 获取所有窗口及其元素。0.9.8 已移除 `Window::hwnd()` 等私有 API，改用公开方法；
    // 需要原生 HWND 时通过 sys::windows::hwnd::find_window_hwnd 映射。
    let mut windows: Vec<xcap::Window> = xcap::Window::all().unwrap_or_default();
    // 按原生 z() 值（越大越靠近顶层）降序排列，使最前面窗口排在列表最前。
    windows.sort_by_key(|w| std::cmp::Reverse(w.z().unwrap_or(0)));

    #[cfg(target_os = "macos")]
    let window_size_scale: f32;
    #[cfg(not(target_os = "macos"))]
    let window_size_scale = 1.0f32;

    #[cfg(target_os = "macos")]
    {
        // macOS 下窗口基于逻辑像素，这里统一转为物理像素
        window_size_scale = window.scale_factor().unwrap_or(1.0) as f32;
    }

    // 串行遍历以保持 z 序，par_iter 收集后顺序不确定会打乱窗口顺序。
    let rect_list = windows
        .iter()
        .filter_map(|window| {
            // 黑名单过滤：检查应用名是否在黑名单中
            #[cfg(target_os = "windows")]
            {
                if let Some(ref bl) = blacklist {
                    if let Ok(app_name) = window.app_name() {
                        let app_name_lower = app_name.to_lowercase();
                        for item in bl {
                            if app_name_lower.contains(&item.to_lowercase()) {
                                return None;
                            }
                        }
                    }
                }
            }

            #[cfg(target_os = "windows")]
            {
                if window.is_minimized().unwrap_or(true) {
                    return None;
                }
            }

            #[cfg(target_os = "macos")]
            {
                if window.is_minimized().unwrap_or(true) {
                    return None;
                }
            }

            let window_title = window.title().unwrap_or_default();

            #[cfg(target_os = "macos")]
            {
                if window_title.eq("Notification Center") || window_title.eq("Dock") {
                    return None;
                }

                if window_title.eq("Cursor") {
                    if window.app_name().unwrap_or_default().eq("Window Server") {
                        return None;
                    }
                }
            }

            #[cfg(target_os = "windows")]
            {
                if window_title.eq("Shell Handwriting Canvas") {
                    return None;
                }
            }

            let window_rect: ElementRect;
            let window_id: u32;
            let x: i32;
            let y: i32;
            let width: i32;
            let height: i32;

            // 用 xcap 公开几何属性替代原 fork 的 get_window_info()/cg_rect_by_cf_dictionary。
            x = window.x().unwrap_or(0);
            y = window.y().unwrap_or(0);
            width = window.width().unwrap_or(0) as i32;
            height = window.height().unwrap_or(0) as i32;

            window_id = match window.id() {
                Ok(id) => id,
                Err(_) => return None,
            };

            window_rect = ElementRect {
                min_x: x,
                min_y: y,
                max_x: x + width,
                max_y: y + height,
            };

            Some(WindowElement {
                element_rect: window_rect.scale(window_size_scale),
                window_id,
            })
        })
        .collect::<Vec<WindowElement>>();

    Ok(rect_list)
}

pub async fn switch_always_on_top(#[allow(unused_variables)] window_id: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        if window_id == 0 {
            return false;
        }

        let window_list = xcap::Window::all().unwrap_or_default();
        let window = window_list
            .iter()
            .find(|w| w.id().unwrap_or(0) == window_id);

        let window = match window {
            Some(window) => window,
            None => return false,
        };

        // 0.9.8 移除 Window::hwnd()，改用本地化映射取原生 HWND。
        let window_hwnd = match snow_shot_app_utils::sys::windows::hwnd::find_window_hwnd(window) {
            Some(hwnd) => hwnd,
            None => return false,
        };

        snow_shot_app_os::utils::switch_always_on_top(window_hwnd.0);
    }

    #[cfg(target_os = "linux")]
    {
        snow_shot_app_os::utils::switch_always_on_top();
    }

    #[cfg(target_os = "macos")]
    {
        snow_shot_app_os::utils::switch_always_on_top();
    }

    true
}

pub async fn get_element_from_position(
    ui_elements: tauri::State<'_, Mutex<UIElements>>,
    mouse_x: i32,
    mouse_y: i32,
) -> Result<Vec<ElementRect>, ()> {
    let mut ui_elements = ui_elements.lock().await;

    let element_rect_list = match ui_elements.get_element_from_point_walker(mouse_x, mouse_y) {
        Ok(element_rect) => element_rect,
        Err(_) => {
            return Err(());
        }
    };

    Ok(element_rect_list)
}

pub async fn get_mouse_position(app: tauri::AppHandle) -> Result<(i32, i32), String> {
    snow_shot_app_utils::get_mouse_position(&app)
}

/// 用于生成唯一的「绘图/截图」窗口标签，避免同一秒内创建多个窗口时标签冲突
static DRAW_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);

pub async fn create_draw_window(app: tauri::AppHandle) {
    let draw_window_label = format!(
        "draw-{}",
        DRAW_WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst)
    );

    let window = match tauri::WebviewWindowBuilder::new(
        &app,
        draw_window_label,
        tauri::WebviewUrl::App(format!("/#/draw").into()),
    )
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .fullscreen(false)
    .title("Snow Shot - Draw")
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .skip_taskbar(true)
    .inner_size(1.0, 1.0)
    .visible(false)
    .focused(false)
    .build()
    {
        Ok(window) => window,
        Err(e) => {
            log::error!("[create_draw_window] Failed to build window: {}", e);
            return;
        }
    };

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Dwm::{
            DWMWA_TRANSITIONS_FORCEDISABLED, DwmSetWindowAttribute,
        };

        let window_hwnd = window.hwnd().unwrap();

        // 禁用窗口动画
        unsafe {
            let disable_transitions: i32 = 1;
            match DwmSetWindowAttribute(
                HWND(window_hwnd.0),
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &disable_transitions as *const _ as *const _,
                std::mem::size_of::<i32>() as u32,
            ) {
                Ok(_) => (),
                Err(_) => {
                    log::error!("[create_draw_window] Failed to disable window transitions");
                }
            }
        }
    }

    window.hide().unwrap();
}

pub async fn set_draw_window_style(window: tauri::Window) {
    snow_shot_app_os::utils::set_draw_window_style(window);
}

/**
 * 捕获全屏
 */
pub async fn capture_full_screen(
    app_handle: tauri::AppHandle,
    enable_multiple_monitor: bool,
    capture_history_file_path: String,
    correct_hdr_color_algorithm: CorrectHdrColorAlgorithm,
    correct_color_filter: bool,
    capture_method: CaptureMethod,
) -> Result<Response, String>
{
    // 激活的显示器
    let (mouse_x, mouse_y) = snow_shot_app_utils::get_mouse_position(&app_handle)?;
    let active_monitor = MonitorList::get_by_region(
        ElementRect {
            min_x: mouse_x,
            min_y: mouse_y,
            max_x: mouse_x,
            max_y: mouse_y,
        },
        correct_hdr_color_algorithm == CorrectHdrColorAlgorithm::None,
    );
    // 所有显示器
    let monitor_list = snow_shot_app_utils::get_capture_monitor_list(
        &app_handle,
        None,
        enable_multiple_monitor,
        correct_hdr_color_algorithm == CorrectHdrColorAlgorithm::None,
    )?;

    // 截取所有显示器的截图
    let all_monitors_image = monitor_list
        .capture(
            None,
            CaptureOption {
                color_format: ColorFormat::Rgb8,
                correct_hdr_color_algorithm,
                correct_color_filter,
                capture_method,
            },
        )
        .await?;
    // 从合并图中裁剪出激活显示器所在区域（使用 image crate 安全裁剪 API）。
    // 单显示器时激活显示器即合并图本身，裁剪结果与整图一致。
    let all_monitors_bounding_box = monitor_list.get_monitors_bounding_box();
    // 获取激活的显示器相对所有显示器的位置
    let active_monitor_rect = active_monitor.get_monitors_bounding_box();
    let active_monitor_crop_region = ElementRect {
        min_x: active_monitor_rect.min_x - all_monitors_bounding_box.min_x,
        min_y: active_monitor_rect.min_y - all_monitors_bounding_box.min_y,
        max_x: active_monitor_rect.max_x - all_monitors_bounding_box.min_x,
        max_y: active_monitor_rect.max_y - all_monitors_bounding_box.min_y,
    };

    let active_monitor_crop_region_x = active_monitor_crop_region.min_x as usize;
    let active_monitor_crop_region_y = active_monitor_crop_region.min_y as usize;
    let active_monitor_crop_region_width =
        (active_monitor_crop_region.max_x - active_monitor_crop_region.min_x) as usize;
    let active_monitor_crop_region_height =
        (active_monitor_crop_region.max_y - active_monitor_crop_region.min_y) as usize;

    // 裁剪区域宽高为零时无法编码（Zero width not allowed），直接返回错误，避免 panic
    if active_monitor_crop_region_width == 0 || active_monitor_crop_region_height == 0 {
        return Err(String::from(
            "[capture_full_screen] active monitor crop region has zero width or height",
        ));
    }

    // crop_imm 返回的是 4 通道 RgbaImage，直接包成 DynamicImage 编码。
    // 该 4 通道路径与区域/窗口截图一致（已验证正常），可规避花屏。
    let active_monitor_image = image::DynamicImage::ImageRgba8(image::imageops::crop_imm(
        &all_monitors_image,
        active_monitor_crop_region_x as u32,
        active_monitor_crop_region_y as u32,
        active_monitor_crop_region_width as u32,
        active_monitor_crop_region_height as u32,
    )
    .to_image());

    // 编码图像为 PNG 格式
    let image_buffer = snow_shot_app_utils::encode_image(
        &active_monitor_image,
        snow_shot_app_utils::ImageEncoder::Png,
    )
    .map_err(|e| e.to_string())?;

    // 写入到截图历史
    let capture_history_file_path = PathBuf::from(capture_history_file_path);
    match all_monitors_image.save(&capture_history_file_path) {
        Ok(_) => (),
        Err(e) => {
            return Err(format!(
                "[capture_full_screen] failed to save capture history image: {}",
                e
            ));
        }
    }

    Ok(Response::new(image_buffer))
}
