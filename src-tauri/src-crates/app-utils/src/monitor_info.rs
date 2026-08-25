use image::{DynamicImage, GenericImageView};
use rayon::iter::{IntoParallelIterator, ParallelIterator};
use serde::{Deserialize, Serialize};
use snow_shot_app_shared::ElementRect;
use xcap::Monitor;

#[cfg(target_os = "windows")]
use crate::monitor_hdr_info::{self, MonitorHdrInfo};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::LPARAM;
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplayMonitors, EnumDisplaySettingsW, HMONITOR,
    MONITORINFOEXW,
};

#[derive(Debug)]
pub struct MonitorInfo {
    pub monitor: Monitor,
    pub rect: ElementRect,
    pub scale_factor: f32,
    #[cfg(target_os = "macos")]
    pub monitor_scale_factor: f64,
    #[cfg(target_os = "windows")]
    pub monitor_hdr_info: MonitorHdrInfo,
}

// `Monitor` 含 `HMONITOR` 裸指针，默认非 Send/Sync；HMONITOR 为只读句柄，可安全共享。
unsafe impl Send for MonitorInfo {}
unsafe impl Sync for MonitorInfo {}

#[derive(Debug, Clone, Copy)]
pub enum ColorFormat {
    Rgba8,
    Rgb8,
}

/// 采样统计图像状态，输出诊断日志：尺寸、alpha 分布、亮度分布。
/// 用于黑屏排查——区分「RGB 全黑」与「alpha=0 透明黑屏」两种根因。
pub(crate) fn log_image_state(tag: &str, image: &image::DynamicImage) {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        log::warn!("[image_state] {} empty image {}x{}", tag, width, height);
        return;
    }

    let step = ((width * height) as usize / 4000).max(1) as u32;
    let mut sampled = 0u32;
    let mut alpha_zero = 0u32;
    let mut alpha_below_10 = 0u32;
    let mut black_rgb = 0u32;
    let mut dark_rgb = 0u32;
    let has_alpha = image.color().has_alpha();

    for y in (0..height).step_by(step as usize) {
        for x in (0..width).step_by(step as usize) {
            let pixel = image.get_pixel(x, y);
            sampled += 1;
            if has_alpha && pixel.0.len() > 3 {
                if pixel[3] == 0 {
                    alpha_zero += 1;
                } else if pixel[3] < 10 {
                    alpha_below_10 += 1;
                }
            }
            let lum = (pixel[0] as u32 + pixel[1] as u32 + pixel[2] as u32) / 3;
            if lum < 8 {
                black_rgb += 1;
            } else if lum < 40 {
                dark_rgb += 1;
            }
        }
    }

    let alpha_zero_ratio = if has_alpha {
        alpha_zero as f32 / sampled as f32
    } else {
        -1.0
    };
    let alpha_below_10_ratio = if has_alpha {
        alpha_below_10 as f32 / sampled as f32
    } else {
        -1.0
    };
    log::info!(
        "[image_state] {} size={}x{} has_alpha={} alpha_zero_ratio={:.3} alpha_below10_ratio={:.3} black_rgb_ratio={:.3} dark_rgb_ratio={:.3}",
        tag,
        width,
        height,
        has_alpha,
        alpha_zero_ratio,
        alpha_below_10_ratio,
        black_rgb as f32 / sampled as f32,
        dark_rgb as f32 / sampled as f32,
    );
}

/// 判断图像是否「全黑 / 近全黑」。采样像素统计近黑比例，超过阈值即视为黑屏。
/// 与 windows_capture_image::is_black_image 逻辑一致，用于多屏合成层对单屏结果二次校验。
/// 注意：不仅统计 RGB 亮度，也统计 Alpha。若整幅图像 Alpha 均为 0（透明黑屏），
/// 即使 RGB 有内容，前端渲染也会显示为全黑（透明背景），同样应判为黑屏触发回退。
fn is_black_image(image: &image::DynamicImage, black_ratio_threshold: f32) -> bool {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return true;
    }

    let step = ((width * height) as usize / 4000).max(1) as u32;
    let mut sampled = 0u32;
    let mut black = 0u32;

    for y in (0..height).step_by(step as usize) {
        for x in (0..width).step_by(step as usize) {
            let pixel = image.get_pixel(x, y);
            sampled += 1;
            let lum = (pixel[0] as u32 + pixel[1] as u32 + pixel[2] as u32) / 3;
            // 有 Alpha 通道且接近透明（< 10），或 RGB 接近全黑，均视为"黑"像素
            let is_transparent = pixel.0.len() > 3 && pixel[3] < 10;
            if lum < 8 || is_transparent {
                black += 1;
            }
        }
    }

    if sampled == 0 {
        return true;
    }

    (black as f32 / sampled as f32) >= black_ratio_threshold
}

#[derive(Serialize, Clone)]
pub struct MonitorRect {
    pub rect: ElementRect,
    pub scale_factor: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct CaptureOption {
    pub color_format: ColorFormat,
    pub correct_hdr_color_algorithm: CorrectHdrColorAlgorithm,
    pub correct_color_filter: bool,
    pub capture_method: CaptureMethod,
}

impl MonitorInfo {
    pub fn new(
        monitor: &Monitor,
        #[cfg(target_os = "windows")] monitor_hdr_info: Option<MonitorHdrInfo>,
    ) -> Self {
        let monitor_rect: ElementRect;
        let scale_factor: f32;

        #[cfg(target_os = "windows")]
        {
            // 0.9.8 的 Monitor::id() 为内部编号而非 HMONITOR，故改用 name 经
            // EnumDisplayMonitors/GetMonitorInfoW/EnumDisplaySettingsW 反查构建矩形。
            let name = monitor.name().unwrap_or_default();
            let hmonitor = Self::get_monitor_handle_by_name(&name);
            let device_name = Self::get_device_name_by_handle(hmonitor).unwrap_or(name);
            let rect = Self::get_dev_mode(&device_name).unwrap_or_default();
            // DEVMODEW 含匿名 union 字段，读取需 unsafe（Rust 2024）。
            let (pos_x, pos_y, pels_w, pels_h) = unsafe {
                (
                    rect.Anonymous1.Anonymous2.dmPosition.x,
                    rect.Anonymous1.Anonymous2.dmPosition.y,
                    rect.dmPelsWidth as i32,
                    rect.dmPelsHeight as i32,
                )
            };
            monitor_rect = ElementRect {
                min_x: pos_x,
                min_y: pos_y,
                max_x: pos_x + pels_w,
                max_y: pos_y + pels_h,
            };
            scale_factor = monitor.scale_factor().unwrap_or(0.0);

            MonitorInfo {
                monitor: monitor.clone(),
                rect: monitor_rect,
                scale_factor,
                monitor_hdr_info: monitor_hdr_info.unwrap_or(MonitorHdrInfo::default()),
            }
        }

        #[cfg(target_os = "macos")]
        {
            let rect = monitor.bounds().unwrap();
            let monitor_scale_factor = monitor.scale_factor().unwrap_or(1.0) as f64;
            monitor_rect = ElementRect {
                min_x: (rect.origin.x * monitor_scale_factor) as i32,
                min_y: (rect.origin.y * monitor_scale_factor) as i32,
                max_x: ((rect.origin.x + rect.size.width) * monitor_scale_factor) as i32,
                max_y: ((rect.origin.y + rect.size.height) * monitor_scale_factor) as i32,
            };
            scale_factor = 0.0;

            MonitorInfo {
                monitor: monitor.clone(),
                rect: monitor_rect,
                scale_factor,
                monitor_scale_factor,
            }
        }
    }

    pub fn get_monitor_crop_region(&self, crop_region: ElementRect) -> ElementRect {
        let monitor_crop_region = self.rect.clip_rect(&ElementRect {
            min_x: crop_region.min_x,
            min_y: crop_region.min_y,
            max_x: crop_region.max_x,
            max_y: crop_region.max_y,
        });

        ElementRect {
            min_x: monitor_crop_region.min_x - self.rect.min_x,
            min_y: monitor_crop_region.min_y - self.rect.min_y,
            max_x: monitor_crop_region.max_x - self.rect.min_x,
            max_y: monitor_crop_region.max_y - self.rect.min_y,
        }
    }

    /// 通过显示器设备名（xcap 的 `Monitor::name()`）反查真实 `HMONITOR`。
    ///
    /// 原版 xcap 的 `Monitor::id()` 返回 u32 内部编号，不再是 `HMONITOR` 句柄，
    /// 因此这里用 `EnumDisplayMonitors` 枚举系统显示器，按 `GetMonitorInfoW`
    /// 返回的 `szDevice`（设备名）与给定名称匹配。找不到时返回空句柄。
    #[cfg(target_os = "windows")]
    pub fn get_monitor_handle(monitor: &Monitor) -> HMONITOR {
        Self::get_monitor_handle_by_name(&monitor.name().unwrap_or_default())
    }

    /// 枚举系统显示器，按设备名匹配返回 `HMONITOR`。
    #[cfg(target_os = "windows")]
    fn get_monitor_handle_by_name(name: &str) -> HMONITOR {
        use std::ffi::c_void;

        struct Ctx<'a> {
            name: &'a str,
            found: HMONITOR,
        }

        unsafe extern "system" fn callback(
            hmonitor: HMONITOR,
            _hdc: windows::Win32::Graphics::Gdi::HDC,
            _rect: *mut windows::Win32::Foundation::RECT,
            lparam: LPARAM,
        ) -> windows_core::BOOL {
            // Rust 2024：unsafe fn 体内解引用裸指针需显式 unsafe 块。
            let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
            let device = MonitorInfo::get_device_name_by_handle(hmonitor).unwrap_or_default();
            if device == ctx.name {
                ctx.found = hmonitor;
                // 停止枚举
                windows_core::BOOL::from(false)
            } else {
                windows_core::BOOL::from(true)
            }
        }

        let mut ctx = Ctx {
            name,
            found: HMONITOR(std::ptr::null_mut::<c_void>()),
        };
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(callback),
                LPARAM(&mut ctx as *mut _ as isize),
            );
        }
        ctx.found
    }

    /// 通过 `HMONITOR` 取得显示器设备名（`\\.\DISPLAYx`）。
    #[cfg(target_os = "windows")]
    fn get_device_name_by_handle(hmonitor: HMONITOR) -> Option<String> {
        use widestring::U16CString;
        use windows::Win32::{
            Foundation::RECT,
            Graphics::Gdi::{GetMonitorInfoW, MONITORINFO},
        };

        if hmonitor.0.is_null() {
            return None;
        }

        let mut monitor_info = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: u32::try_from(std::mem::size_of::<MONITORINFOEXW>()).unwrap(),
                rcMonitor: RECT::default(),
                rcWork: RECT::default(),
                dwFlags: 0,
            },
            szDevice: [0; 32],
        };

        let result = unsafe {
            GetMonitorInfoW(
                hmonitor,
                std::ptr::addr_of_mut!(monitor_info).cast(),
            )
        };

        if !result.as_bool() {
            return None;
        }

        U16CString::from_vec_truncate(monitor_info.szDevice)
            .to_string()
            .ok()
    }

    /// 通过显示器设备名读取当前设置的 `DEVMODEW`（含位置与分辨率）。
    #[cfg(target_os = "windows")]
    fn get_dev_mode(device_name: &str) -> Option<DEVMODEW> {
        let name_u16: Vec<u16> = device_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let mut dev_mode: DEVMODEW = unsafe { std::mem::zeroed() };
        dev_mode.dmSize = u16::try_from(std::mem::size_of::<DEVMODEW>()).unwrap();

        let result = unsafe {
            EnumDisplaySettingsW(
                windows::core::PCWSTR(name_u16.as_ptr()),
                ENUM_CURRENT_SETTINGS,
                &mut dev_mode,
            )
        };

        if result.as_bool() {
            Some(dev_mode)
        } else {
            None
        }
    }

    /// 获取显示器设备名称
    #[cfg(target_os = "windows")]
    pub fn get_device_name(monitor: &Monitor) -> Result<String, String> {
        use widestring::U16CString;
        use windows::Win32::{
            Foundation::RECT,
            Graphics::Gdi::{GetMonitorInfoW, MONITORINFO, MONITORINFOEXW},
        };

        let mut monitor_info = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: u32::try_from(std::mem::size_of::<MONITORINFOEXW>()).unwrap(),
                rcMonitor: RECT::default(),
                rcWork: RECT::default(),
                dwFlags: 0,
            },
            szDevice: [0; 32],
        };

        let result = unsafe {
            GetMonitorInfoW(
                Self::get_monitor_handle(monitor),
                std::ptr::addr_of_mut!(monitor_info).cast(),
            )
        };

        if !result.as_bool() {
            return Err(format!(
                "[MonitorInfo::get_device_name] Failed to get monitor info: {:?}",
                result
            ));
        }

        let device_name = match U16CString::from_vec_truncate(monitor_info.szDevice).to_string() {
            Ok(name) => name,
            Err(e) => {
                return Err(format!(
                    "[MonitorInfo::get_device_name] Failed to get device name: {:?}",
                    e
                ));
            }
        };

        Ok(device_name)
    }

    pub fn capture(
        &self,
        crop_area: Option<ElementRect>,
        exclude_window: Option<&tauri::Window>,
        capture_option: CaptureOption,
    ) -> Option<image::DynamicImage> {
        #[cfg(target_os = "macos")]
        {
            return super::capture_target_monitor(
                &self.monitor,
                crop_area,
                exclude_window,
                capture_option.color_format,
            );
        }

        #[cfg(target_os = "windows")]
        {
            use crate::windows_capture_image;

            let mut capture_hdr_image: Option<image::DynamicImage> = None;
            // 实际使用的采集方式：
            //   Auto -> 仅当系统 HDR 真正开启（hdr_enabled）时走 WGC
            //   Wgc  -> 始终 windows-capture
            //   Xcap -> 始终 xcap
            let effective_method = match capture_option.capture_method {
                CaptureMethod::Auto => {
                    if self.monitor_hdr_info.hdr_enabled {
                        CaptureMethod::Wgc
                    } else {
                        CaptureMethod::Xcap
                    }
                }
                other => other,
            };

            match effective_method {
                CaptureMethod::Wgc => {
                    match windows_capture_image::capture_monitor_image(
                        &self,
                        None,
                        crop_area,
                        capture_option.color_format,
                        capture_option.correct_hdr_color_algorithm,
                    ) {
                        Ok(image) => {
                            // WGC 截到黑帧（如 Rgba16F 线性转换异常、首帧空帧重试耗尽）时，
                            // 回退 xcap 兜底，避免把黑屏直接交给用户。
                            if is_black_image(&image, 0.99) {
                                log::warn!(
                                    "[MonitorInfo::capture] WGC returned black frame, falling back to xcap, monitor: {:?}",
                                    self.monitor.name()
                                );
                                capture_hdr_image = super::capture_target_monitor(
                                    &self.monitor,
                                    crop_area,
                                    exclude_window,
                                    capture_option.color_format,
                                );
                            } else {
                                capture_hdr_image = Some(image);
                            }
                        }
                        Err(e) => {
                            log::error!(
                                "[MonitorInfo::capture] Failed to capture WGC monitor image: {:?}",
                                e
                            );
                            // WGC 启动失败，回退 xcap（保持原有兜底语义）
                            capture_hdr_image = super::capture_target_monitor(
                                &self.monitor,
                                crop_area,
                                exclude_window,
                                capture_option.color_format,
                            );
                        }
                    }
                }
                CaptureMethod::Xcap => {
                    // xcap 路径：xcap 在 HDR/宽色域显示器上可能截到黑帧（DXGI 桌面复制的已知限制），
                    // 检测到黑帧时回退 WGC 重截。
                    capture_hdr_image = super::capture_target_monitor(
                        &self.monitor,
                        crop_area,
                        exclude_window,
                        capture_option.color_format,
                    );
                    if let Some(ref image) = capture_hdr_image {
                        if is_black_image(image, 0.99) {
                            log::warn!(
                                "[MonitorInfo::capture] xcap returned black frame, falling back to WGC, monitor: {:?}",
                                self.monitor.name()
                            );
                            capture_hdr_image =
                                windows_capture_image::capture_monitor_image(
                                    &self,
                                    None,
                                    crop_area,
                                    capture_option.color_format,
                                    capture_option.correct_hdr_color_algorithm,
                                )
                                .ok();
                        }
                    }
                }
                CaptureMethod::Auto => {
                    // effective_method 已把 Auto 解析为 Wgc / Xcap，这里不会走到
                }
            }

            if let Some(ref image) = capture_hdr_image {
                log_image_state(
                    &format!("MonitorInfo::capture end (method={:?})", effective_method),
                    image,
                );
            } else {
                log::warn!(
                    "[MonitorInfo::capture] capture_hdr_image is None, monitor: {:?}",
                    self.monitor.name()
                );
            }

            capture_hdr_image
        }
    }
}

#[derive(Debug)]
pub struct MonitorList(Vec<MonitorInfo>);

#[derive(Serialize, Deserialize, Clone, Debug, Copy, PartialEq)]
pub enum CorrectHdrColorAlgorithm {
    None,
    Linear,
}

/// 截图采集方式（后端选择）
#[derive(Serialize, Deserialize, Clone, Debug, Copy, PartialEq)]
pub enum CaptureMethod {
    /// 自动：根据显示器 HDR 能力选择。
    /// HDR/宽色域显示器走 WGC（xcap 会截到黑帧），普通 SDR 显示器走 xcap。
    #[serde(rename = "Auto")]
    Auto,
    /// Windows Graphics Capture（现代捕获 API）
    #[serde(rename = "WGC")]
    Wgc,
    /// xcap（传统采集 API）
    #[serde(rename = "Xcap")]
    Xcap,
}

impl MonitorList {
    // ignore_sdr_info 仅作保留参数（历史语义为"是否跳过 HDR 信息读取"），
    // 现在 HDR 显示器识别始终进行，是否做亮度校正改由 CaptureOption 中的 algorithm 控制，
    // 以避免 xcap 在 HDR/宽色域显示器上截到黑帧。
    fn get_monitors(
        region: Option<ElementRect>,
        #[allow(unused_variables)] ignore_sdr_info: bool,
    ) -> MonitorList {
        let monitors = Monitor::all().unwrap_or_default();

        let region = match region {
            Some(region) => region,
            None => ElementRect {
                min_x: i32::MIN,
                min_y: i32::MIN,
                max_x: i32::MAX,
                max_y: i32::MAX,
            },
        };

        #[cfg(target_os = "windows")]
        let monitor_hdr_info_map = match monitor_hdr_info::get_all_monitors_sdr_info() {
            Ok(monitor_hdr_info_map) => Some(monitor_hdr_info_map),
            Err(e) => {
                log::error!(
                    "[MonitorList::get_monitors] Failed to get monitor HDR info: {:?}",
                    e
                );
                None
            }
        };

        let monitor_info_list = monitors
            .iter()
            .map(|monitor| {
                #[cfg(target_os = "windows")]
                {
                    MonitorInfo::new(
                        monitor,
                        match &monitor_hdr_info_map {
                            Some(monitor_hdr_info_map) => Some(
                                monitor_hdr_info_map
                                    .get(
                                        MonitorInfo::get_device_name(monitor)
                                            .unwrap_or_default()
                                            .as_str(),
                                    )
                                    .unwrap_or(&MonitorHdrInfo::default())
                                    .clone(),
                            ),
                            None => None,
                        },
                    )
                }

                #[cfg(target_os = "macos")]
                {
                    MonitorInfo::new(monitor)
                }
            })
            .filter(|monitor| monitor.rect.overlaps(&region))
            .collect::<Vec<MonitorInfo>>();

        MonitorList(monitor_info_list)
    }

    pub fn all(ignore_sdr_info: bool) -> MonitorList {
        Self::get_monitors(None, ignore_sdr_info)
    }

    pub fn get_by_region(region: ElementRect, ignore_sdr_info: bool) -> MonitorList {
        Self::get_monitors(Some(region), ignore_sdr_info)
    }

    /// 获取所有显示器的最小矩形
    pub fn get_monitors_bounding_box(&self) -> ElementRect {
        let monitors = &self.0;

        if monitors.is_empty() {
            return ElementRect {
                min_x: 0,
                min_y: 0,
                max_x: 0,
                max_y: 0,
            };
        }

        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;

        for monitor in monitors {
            if monitor.rect.min_x < min_x {
                min_x = monitor.rect.min_x;
            }
            if monitor.rect.min_y < min_y {
                min_y = monitor.rect.min_y;
            }
            if monitor.rect.max_x > max_x {
                max_x = monitor.rect.max_x;
            }
            if monitor.rect.max_y > max_y {
                max_y = monitor.rect.max_y;
            }
        }

        ElementRect {
            min_x,
            min_y,
            max_x,
            max_y,
        }
    }

    /// 捕获所有显示器，拼接为一个完整的图像
    ///
    /// @param crop_region 显示器的裁剪区域
    async fn capture_future(
        &self,
        crop_region: Option<ElementRect>,
        exclude_window: Option<&tauri::Window>,
        capture_option: CaptureOption,
    ) -> Result<image::DynamicImage, String> {
        let monitors = &self.0;

        // 特殊情况，只有一个显示器，直接返回
        if monitors.len() == 1 {
            let first_monitor = monitors.first().unwrap();
            let capture_image = first_monitor.capture(
                if let Some(crop_region) = crop_region {
                    Some(first_monitor.get_monitor_crop_region(crop_region))
                } else {
                    None
                },
                exclude_window,
                capture_option,
            );

            // 有些捕获失败的显示器，返回一个空图像，这里需要特殊处理
            if let Some(capture_image) = capture_image.as_ref() {
                if capture_image.width() == 1 && capture_image.height() == 1 {
                    return match capture_option.color_format {
                        ColorFormat::Rgb8 => Ok(image::DynamicImage::new_rgb8(
                            (first_monitor.rect.max_x - first_monitor.rect.min_x) as u32,
                            (first_monitor.rect.max_y - first_monitor.rect.min_y) as u32,
                        )),
                        ColorFormat::Rgba8 => Ok(image::DynamicImage::new_rgba8(
                            (first_monitor.rect.max_x - first_monitor.rect.min_x) as u32,
                            (first_monitor.rect.max_y - first_monitor.rect.min_y) as u32,
                        )),
                    };
                }
            }

            return match capture_image {
                Some(capture_image) => Ok(capture_image),
                None => {
                    return Err(format!(
                        "[MonitorInfoList::capture] Failed to capture monitor image, monitor rect: {:?}",
                        first_monitor.rect
                    ));
                }
            };
        }

        // 将每个显示器截取的图像，绘制到该图像上
        // 注意：多显示器必须串行捕获，不能并行。
        // 每个 monitor.capture() 内部会通过 windows-capture 启动一个 Graphics Capture (WGC) session，
        // 而 WGC 的 D3D11 设备/帧缓冲在进程内共享，同时启动多个 session 会互相冲突导致黑屏。
        // 单显示器因为只有 1 个 session 所以正常，多显示器并行就会黑屏。
        // 这里同时把原始 monitor 引用一起携带，避免后续用过滤后 Vec 的 index 反查原始列表导致 offset 错位。
        // 诊断日志：输出参与捕获的显示器数量、裁剪区域、目标色彩格式
        log::info!(
            "[MonitorInfoList::capture] multi-monitor capture start: monitors={}, color_format={:?}, crop_region={:?}",
            monitors.len(),
            capture_option.color_format,
            crop_region
        );

        let monitor_image_list = monitors
            .iter()
            .filter(|monitor| monitor.rect.overlaps(&crop_region.unwrap_or(ElementRect {
                min_x: i32::MIN,
                min_y: i32::MIN,
                max_x: i32::MAX,
                max_y: i32::MAX,
            })))
            .filter_map(|monitor| {
                let monitor_crop_region = if let Some(crop_region) = crop_region {
                    Some(monitor.get_monitor_crop_region(crop_region))
                } else {
                    None
                };

                // 诊断日志：按用户设置的采集方式与 HDR 状态推算本次实际使用的引擎
                // 注意：不能只用 hdr_enabled / sdr_white_level 判断——HDR 面板的
                // sdr_white_level 恒 > 0，会导致标签永远显示 WGC(HDR)，误导排查。
                let capture_source = match capture_option.capture_method {
                    CaptureMethod::Wgc => "WGC",
                    CaptureMethod::Xcap => "xcap",
                    CaptureMethod::Auto => {
                        if monitor.monitor_hdr_info.hdr_enabled {
                            "Auto->WGC"
                        } else {
                            "Auto->xcap"
                        }
                    }
                };
                log::info!(
                    "[MonitorInfoList::capture] capturing monitor: name={:?}, rect={:?}, hdr_enabled={}, capture_method={:?}, source={}",
                    monitor.monitor.name(),
                    monitor.rect,
                    monitor.monitor_hdr_info.hdr_enabled,
                    capture_option.capture_method,
                    capture_source
                );

                // 单屏捕获后做黑屏检测，命中则重试最多 3 次（重截该显示器）。
                // 多屏场景下某块显示器可能单独截到黑帧（WGC 会话冲突/冷启动），
                // 只重截该块，避免整批重来。
                const BLACK_RETRY_TIMES: u32 = 3;
                let mut capture_image =
                    monitor.capture(monitor_crop_region, exclude_window, capture_option);
                let mut black_retried = false;
                if let Some(ref img) = capture_image {
                    if is_black_image(img, 0.99) {
                        for attempt in 1..=BLACK_RETRY_TIMES {
                            log::warn!(
                                "[MonitorInfoList::capture] detected black frame on monitor {:?}, retrying capture (attempt {})",
                                monitor.monitor.name(),
                                attempt
                            );
                            capture_image =
                                monitor.capture(monitor_crop_region, exclude_window, capture_option);
                            black_retried = true;
                            if let Some(ref img2) = capture_image {
                                if !is_black_image(img2, 0.99) {
                                    break;
                                }
                            } else {
                                break;
                            }
                        }
                    }
                }

                match capture_image {
                    Some(image) => {
                        if black_retried {
                            log::info!(
                                "[MonitorInfoList::capture] monitor recovered after black-frame retry: name={:?}",
                                monitor.monitor.name()
                            );
                        }
                        log::info!(
                            "[MonitorInfoList::capture] captured monitor OK: name={:?}, image_size={}x{}, color={:?}",
                            monitor.monitor.name(),
                            image.width(),
                            image.height(),
                            image.color()
                        );
                        Some((monitor, image, monitor_crop_region))
                    }
                    None => {
                        log::warn!(
                            "[MonitorInfoList::capture] Failed to capture monitor image, monitor rect: {:?}",
                            monitor.rect
                        );

                        None
                    }
                }
            })
            .collect::<Vec<(&MonitorInfo, image::DynamicImage, Option<ElementRect>)>>();

        if monitor_image_list.is_empty() {
            return Err(format!(
                "[MonitorInfoList::capture] Failed to capture monitor image, monitor_image_list is empty, crop_region: {:?}",
                crop_region
            ));
        }

        // 获取能容纳所有显示器的最小矩形
        let monitors_bounding_box = self.get_monitors_bounding_box();

        // 声明该图像，分配内存
        let (capture_image_width, capture_image_height) = if let Some(crop_region) = crop_region {
            (
                (crop_region.max_x - crop_region.min_x) as usize,
                (crop_region.max_y - crop_region.min_y) as usize,
            )
        } else {
            (
                (monitors_bounding_box.max_x - monitors_bounding_box.min_x) as usize,
                (monitors_bounding_box.max_y - monitors_bounding_box.min_y) as usize,
            )
        };

        let pixel_len = match capture_option.color_format {
            ColorFormat::Rgb8 => 3,
            ColorFormat::Rgba8 => 4,
        };

        let mut capture_image_pixels: Vec<u8> =
            vec![0; capture_image_width * capture_image_height * pixel_len];

        let capture_image_pixels_ptr = capture_image_pixels.as_mut_ptr() as usize;

        // 多显示器必须串行处理（见上方注释：WGC session 并行会冲突黑屏），
        // 且 &MonitorInfo 含 xcap::Monitor（非 Sync），不能用 par_iter。
        monitor_image_list.iter().for_each(
            |(monitor, monitor_image, monitor_crop_region)| {
                // 计算显示器在合并图像中的位置
                let offset_x: i32;
                let offset_y: i32;

                if let Some(monitor_crop_region) = monitor_crop_region {
                    let crop_region = crop_region.unwrap();

                    // 将单个显示器的坐标转为整个显示器的坐标
                    // 得到图像相对整个显示器的坐标后，再减去裁剪区域的坐标，得到图像相对裁剪区域的坐标
                    offset_x = monitor_crop_region.min_x + monitor.rect.min_x - crop_region.min_x;
                    offset_y = monitor_crop_region.min_y + monitor.rect.min_y - crop_region.min_y;
                } else {
                    offset_x = monitor.rect.min_x - monitors_bounding_box.min_x;
                    offset_y = monitor.rect.min_y - monitors_bounding_box.min_y;
                }

                // 诊断日志：当前显示器在合并图中的偏移与尺寸
                log::info!(
                    "[MonitorInfoList::capture] overlay monitor: name={:?}, offset=({},{}) image_size={}x{}",
                    monitor.monitor.name(),
                    offset_x,
                    offset_y,
                    monitor_image.width(),
                    monitor_image.height()
                );

                if offset_x < 0 || offset_y < 0 {
                    log::error!(
                        "[MonitorInfoList::capture] offset_x or offset_y is less than 0, offset_x: {:?}, offset_y: {:?}",
                        offset_x,
                        offset_y
                    );
                }

                // 将显示器图像绘制到合并图像上
                super::overlay_image_ptr(
                    capture_image_pixels_ptr as *mut u8,
                    capture_image_width,
                    monitor_image,
                    offset_x as usize,
                    offset_y as usize,
                    pixel_len,
                );
            },
        );

        let capture_image = match capture_option.color_format {
            ColorFormat::Rgb8 => image::DynamicImage::ImageRgb8(
                image::RgbImage::from_raw(
                    capture_image_width as u32,
                    capture_image_height as u32,
                    capture_image_pixels,
                )
                .unwrap(),
            ),
            ColorFormat::Rgba8 => {
                // 合成缓冲初始化为全 0（alpha 为 0）。若单屏图（尤其 xcap 路径）alpha 为 0，
                // 合成图会整幅透明，前端渲染显示为黑屏。因此合成后统一强制 alpha=255，
                // 确保最终交付给前端的图一定不透明（截图场景不需要透明通道）。
                for y in 0..capture_image_height {
                    for x in 0..capture_image_width {
                        let index = (y * capture_image_width + x) * 4 + 3;
                        capture_image_pixels[index] = 255;
                    }
                }
                image::DynamicImage::ImageRgba8(
                    image::RgbaImage::from_raw(
                        capture_image_width as u32,
                        capture_image_height as u32,
                        capture_image_pixels,
                    )
                    .unwrap(),
                )
            }
        };

        // 诊断日志：合成完成，输出最终尺寸
        log::info!(
            "[MonitorInfoList::capture] multi-monitor composite done: final_size={}x{}, monitors_composited={}",
            capture_image.width(),
            capture_image.height(),
            monitor_image_list.len()
        );
        log_image_state("MonitorInfoList::capture composite final", &capture_image);

        Ok(capture_image)
    }

    #[inline(always)]
    fn apply_color_matrix_to_channel(
        channel_index: usize,
        red_f: f32,
        green_f: f32,
        blue_f: f32,
        output_pixel: *mut u8,
        matrix: &[f32; 25],
    ) {
        let mut current_result = 0.0;

        // 处理 RGB 变换
        current_result += matrix[channel_index * 5 + 0] * red_f; // 注意 current_output 未初始化
        current_result += matrix[channel_index * 5 + 1] * green_f;
        current_result += matrix[channel_index * 5 + 2] * blue_f;

        // 第5行提供平移（相加）操作：直接加上第5行对应的值
        current_result += matrix[4 * 5 + channel_index];

        unsafe {
            output_pixel
                .add(channel_index)
                .write(if current_result > 1.0 {
                    255
                } else if current_result < 0.0 {
                    0
                } else {
                    (current_result * 255.0) as u8
                });
        }
    }

    /// 应用 5x5 颜色变换矩阵到 RGB 像素
    fn apply_color_matrix(pixel: *const u8, output_pixel: *mut u8, matrix: &[f32; 25]) {
        let (red_f, green_f, blue_f) = unsafe {
            (
                *pixel.add(0) as f32 / 255.0,
                *pixel.add(1) as f32 / 255.0,
                *pixel.add(2) as f32 / 255.0,
            )
        };

        // 前 3 行：矩阵乘法计算 RGB 变换（不处理 alpha 通道）
        Self::apply_color_matrix_to_channel(0, red_f, green_f, blue_f, output_pixel, matrix);
        Self::apply_color_matrix_to_channel(1, red_f, green_f, blue_f, output_pixel, matrix);
        Self::apply_color_matrix_to_channel(2, red_f, green_f, blue_f, output_pixel, matrix);
    }

    /// 将颜色矩阵应用到整个图像
    fn apply_color_effect_to_image(
        image: &mut DynamicImage,
        matrix: &[f32; 25],
        color_format: ColorFormat,
    ) -> Result<(), String> {
        let (width, height) = image.dimensions();

        let (pixel_len, image_raw_ptr) = match color_format {
            ColorFormat::Rgba8 => (4, image.as_mut_rgba8().unwrap().as_mut_ptr()),
            ColorFormat::Rgb8 => (3, image.as_mut_rgb8().unwrap().as_mut_ptr()),
        };

        let image_raw_ptr = image_raw_ptr as usize;
        let output_data_ptr = image_raw_ptr as usize;

        let pixel_count = (width * height) as usize;

        (0..pixel_count).into_par_iter().for_each(|pixel_index| {
            let index = pixel_index * pixel_len;
            unsafe {
                Self::apply_color_matrix(
                    (image_raw_ptr as *const u8).add(index),
                    (output_data_ptr as *mut u8).add(index),
                    matrix,
                );
            }
        });

        Ok(())
    }

    fn invert_color_matrix(matrix: &[f32; 25]) -> Result<[f32; 25], String> {
        /// 计算 3x3 矩阵的行列式
        #[inline(always)]
        fn determinant_3x3(m: &[[f32; 3]; 3]) -> f32 {
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
        }

        /// 计算 3x3 矩阵的逆矩阵（优化版）
        #[inline(always)]
        fn invert_3x3_matrix(m: &[[f32; 3]; 3]) -> Option<[[f32; 3]; 3]> {
            let det = determinant_3x3(m);
            if det.abs() < f32::EPSILON * 100.0 {
                return None;
            }

            let inv_det = 1.0 / det;

            // 使用伴随矩阵公式，但优化计算顺序减少重复访问
            let m00 = m[0][0];
            let m01 = m[0][1];
            let m02 = m[0][2];
            let m10 = m[1][0];
            let m11 = m[1][1];
            let m12 = m[1][2];
            let m20 = m[2][0];
            let m21 = m[2][1];
            let m22 = m[2][2];

            // 预计算中间值以减少重复计算
            let c00 = m11 * m22 - m12 * m21;
            let c01 = m12 * m20 - m10 * m22;
            let c02 = m10 * m21 - m11 * m20;

            let c10 = m02 * m21 - m01 * m22;
            let c11 = m00 * m22 - m02 * m20;
            let c12 = m01 * m20 - m00 * m21;

            let c20 = m01 * m12 - m02 * m11;
            let c21 = m02 * m10 - m00 * m12;
            let c22 = m00 * m11 - m01 * m10;

            Some([
                [c00 * inv_det, c01 * inv_det, c02 * inv_det],
                [c10 * inv_det, c11 * inv_det, c12 * inv_det],
                [c20 * inv_det, c21 * inv_det, c22 * inv_det],
            ])
        }

        /// 计算矩阵-向量乘法：result = -matrix * vector
        #[inline(always)]
        fn matrix_vector_mul_neg(matrix: &[[f32; 3]; 3], vector: [f32; 3]) -> [f32; 3] {
            [
                -(matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2]),
                -(matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2]),
                -(matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2]),
            ]
        }

        // 直接提取 3x3 线性变换矩阵和 3x1 平移向量
        let linear_matrix = [
            [matrix[0], matrix[1], matrix[2]],    // R 行
            [matrix[5], matrix[6], matrix[7]],    // G 行
            [matrix[10], matrix[11], matrix[12]], // B 行
        ];
        let translation = [matrix[20], matrix[21], matrix[22]]; // RGB 平移

        // 计算线性变换的逆矩阵
        let inv_linear = invert_3x3_matrix(&linear_matrix).ok_or(
            "[MonitorInfoList::invert_color_matrix] linear_matrix is not invertible".to_string(),
        )?;

        // 计算逆平移向量
        let inv_translation = matrix_vector_mul_neg(&inv_linear, translation);

        // 构建反转的 5x5 矩阵
        let mut inverted_matrix = [0.0f32; 25];

        // RGB 变换行（直接映射到正确的索引位置）
        inverted_matrix[0] = inv_linear[0][0];
        inverted_matrix[1] = inv_linear[0][1];
        inverted_matrix[2] = inv_linear[0][2];

        inverted_matrix[5] = inv_linear[1][0];
        inverted_matrix[6] = inv_linear[1][1];
        inverted_matrix[7] = inv_linear[1][2];

        inverted_matrix[10] = inv_linear[2][0];
        inverted_matrix[11] = inv_linear[2][1];
        inverted_matrix[12] = inv_linear[2][2];

        // Alpha 通道保持单位变换：[0, 0, 0, 1, 0]
        inverted_matrix[15] = 0.0; // Alpha R
        inverted_matrix[16] = 0.0; // Alpha G
        inverted_matrix[17] = 0.0; // Alpha B
        inverted_matrix[18] = 1.0; // Alpha A
        inverted_matrix[19] = 0.0; // Alpha 偏移

        // 平移行
        inverted_matrix[20] = inv_translation[0]; // R 偏移
        inverted_matrix[21] = inv_translation[1]; // G 偏移
        inverted_matrix[22] = inv_translation[2]; // B 偏移
        inverted_matrix[23] = 0.0; // A 偏移

        // 最后一行：[0, 0, 0, 0, 1] 用于仿射变换
        inverted_matrix[24] = 1.0;

        Ok(inverted_matrix)
    }

    /**
     * 获取 Windows 下放大镜的反转颜色变换矩阵
     * 用于还原被放大镜颜色效果影响的图像
     */
    pub async fn get_mag_color_effect_inverse(
        correct_color_filter: bool,
    ) -> Result<Option<[f32; 25]>, String> {
        if !correct_color_filter {
            return Ok(None);
        }

        match Self::get_mag_color_effect().await? {
            Some(matrix) => {
                let inverted = Self::invert_color_matrix(&matrix)?;
                Ok(Some(inverted))
            }
            None => Ok(None),
        }
    }

    /**
     * 获取 Windows 下放大镜的颜色变换举证
     */
    async fn get_mag_color_effect() -> Result<Option<[f32; 25]>, String> {
        #[cfg(not(target_os = "windows"))]
        {
            return Ok(None);
        }

        #[cfg(target_os = "windows")]
        {
            let init_result = unsafe { windows::Win32::UI::Magnification::MagInitialize() };
            if !init_result.as_bool() {
                log::warn!(
                    "[MonitorInfoList::get_mag_color_effect] Failed to initialize magnification library"
                );
                return Ok(None);
            }

            let mut current_effect = windows::Win32::UI::Magnification::MAGCOLOREFFECT::default();
            let get_effect_result = unsafe {
                windows::Win32::UI::Magnification::MagGetFullscreenColorEffect(&mut current_effect)
            };

            // 释放 Mag
            let uninit_result = unsafe { windows::Win32::UI::Magnification::MagUninitialize() };
            if !uninit_result.as_bool() {
                log::warn!(
                    "[MonitorInfoList::get_mag_color_effect] Failed to uninitialize magnification library"
                );
            }

            if !get_effect_result.as_bool() {
                log::warn!(
                    "[MonitorInfoList::get_mag_color_effect] Failed to get magnification color effect"
                );
                return Ok(None);
            }

            let matrix = current_effect.transform;
            // 无任何效果的默认矩阵
            const NORMAL_MATRIX: [f32; 25] = [
                1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ];
            // 判断 matrix 是否等于 NORMAL_MATRIX
            if matrix.eq(&NORMAL_MATRIX) {
                return Ok(None);
            }

            Ok(Some(matrix))
        }
    }

    async fn capture_core(
        &self,
        crop_region: Option<ElementRect>,
        exclude_window: Option<&tauri::Window>,
        capture_option: CaptureOption,
    ) -> Result<image::DynamicImage, String> {
        let enable_exclude_window = {
            #[cfg(target_os = "windows")]
            {
                // 排除窗口（WDA_EXCLUDEFROMCAPTURE）仅在 WGC 下有效（xcap 不支持）。
                //   Wgc  -> 始终排除截图自身窗口
                //   Auto -> 仅当存在系统 HDR 已开启的显示器（Auto 下这些屏会走 WGC）时排除
                //   Xcap -> 不排除
                // 排除可避免截太快把截图控件也截进去。
                match capture_option.capture_method {
                    CaptureMethod::Wgc => true,
                    CaptureMethod::Auto => self
                        .0
                        .iter()
                        .any(|monitor| monitor.monitor_hdr_info.hdr_enabled),
                    CaptureMethod::Xcap => false,
                }
            }

            #[cfg(target_os = "macos")]
            {
                false
            }
        };

        // 设置截图窗口不参与捕获（WGC 下才需要）。
        // 注意：这里设置后【不复位】为 WDA_NONE。截图窗口在存活期间
        // 应始终保持排除状态，避免快速连续截图时「复位 false」与「下一次
        // 设置 true」产生竞态，导致某一帧把截图控件也截进去。
        // 窗口被 close_window_after_delay 销毁时，系统会自动清除该标记。
        if enable_exclude_window {
            if let Some(exclude_window) = exclude_window {
                crate::set_exclude_from_capture(exclude_window, true)
                    .await
                    .map_err(|e| {
                        format!(
                            "[MonitorInfoList::capture_core] failed to set exclude from capture: {:?}",
                            e
                        )
                    })?;
            }
        }

        let result = tokio::try_join!(
            self.capture_future(crop_region, exclude_window, capture_option,),
            Self::get_mag_color_effect_inverse(capture_option.correct_color_filter)
        );

        match result {
            Ok((mut image, color_effect)) => {
                let image = match color_effect {
                    Some(matrix) => {
                        Self::apply_color_effect_to_image(
                            &mut image,
                            &matrix,
                            capture_option.color_format,
                        )?;

                        image
                    }
                    None => image,
                };

                Ok(image)
            }
            Err(e) => {
                log::error!("[MonitorInfoList::capture_core] failed to capture: {:?}", e);
                Err(e)
            }
        }
    }

    pub async fn capture(
        &self,
        exclude_window: Option<&tauri::Window>,
        capture_option: CaptureOption,
    ) -> Result<image::DynamicImage, String> {
        self.capture_core(None, exclude_window, capture_option)
            .await
    }

    pub async fn capture_region(
        &self,
        region: ElementRect,
        exclude_window: Option<&tauri::Window>,
        capture_option: CaptureOption,
    ) -> Result<image::DynamicImage, String> {
        self.capture_core(Some(region), exclude_window, capture_option)
            .await
    }

    pub fn monitor_rect_list(&self) -> Vec<MonitorRect> {
        self.0
            .iter()
            .map(|monitor| MonitorRect {
                rect: monitor.rect,
                scale_factor: monitor.scale_factor,
            })
            .collect()
    }

    pub fn iter(&self) -> impl Iterator<Item = &MonitorInfo> {
        self.0.iter()
    }
}

#[cfg(test)]
mod tests {
    use std::env;

    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn test_get_all_monitors() {
        use crate::monitor_hdr_info;

        let monitors = MonitorList::all(true);
        println!("monitors: {:?}", monitors);

        let monitor_hdr_info_map = monitor_hdr_info::get_all_monitors_sdr_info().unwrap();
        println!("monitor_hdr_info_map: {:?}", monitor_hdr_info_map);

        for monitor in monitors.iter() {
            println!(
                "monitor: {:?}",
                MonitorInfo::get_device_name(&monitor.monitor).unwrap()
            );
            println!(
                "monitor_hdr_info: {:?}",
                monitor_hdr_info_map
                    .get(
                        MonitorInfo::get_device_name(&monitor.monitor)
                            .unwrap()
                            .as_str()
                    )
                    .unwrap()
            );
        }
    }

    #[tokio::test]
    async fn test_capture_multi_monitor() {
        let instance = std::time::Instant::now();

        let crop_region: ElementRect;
        #[cfg(target_os = "windows")]
        {
            crop_region = ElementRect {
                min_x: -3840,
                min_y: 0,
                max_x: 3840,
                max_y: 2160,
            };
        }
        #[cfg(target_os = "macos")]
        {
            crop_region = ElementRect {
                min_x: 0,
                min_y: 0,
                max_x: 7680,
                max_y: 2160,
            };
        }

        let monitors = MonitorList::get_by_region(crop_region, true);

        let image = monitors
            .capture(
                None,
                CaptureOption {
                    color_format: ColorFormat::Rgb8,
                    correct_hdr_color_algorithm: CorrectHdrColorAlgorithm::None,
                    correct_color_filter: false,
                    capture_method: CaptureMethod::Wgc,
                },
            )
            .await
            .unwrap();

        println!("current_dir: {:?}", env::current_dir().unwrap());

        image
            .save(
                std::path::PathBuf::from(env::current_dir().unwrap())
                    .join("../../test_output/capture_multi_monitor.webp"),
            )
            .unwrap();

        println!("time: {:?}", instance.elapsed());
    }

    #[test]
    fn test_invert_color_matrix() {
        // 测试单位矩阵的反转
        let identity: [f32; 25] = [
            1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];

        let inverted = MonitorList::invert_color_matrix(&identity).unwrap();
        assert_eq!(inverted, identity);

        // 测试简单的缩放矩阵
        let scale_matrix: [f32; 25] = [
            2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];

        let inverted_scale = MonitorList::invert_color_matrix(&scale_matrix).unwrap();
        let expected_scale: [f32; 25] = [
            0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];

        for (i, (&actual, &expected)) in
            inverted_scale.iter().zip(expected_scale.iter()).enumerate()
        {
            assert!(
                (actual - expected).abs() < 1e-6,
                "Index {}: {} != {}",
                i,
                actual,
                expected
            );
        }

        // 测试带平移的矩阵
        let translate_matrix: [f32; 25] = [
            1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.1, 0.2, 0.3, 0.0, 1.0,
        ];

        let inverted_translate = MonitorList::invert_color_matrix(&translate_matrix).unwrap();
        let expected_translate: [f32; 25] = [
            1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, -0.1, -0.2, -0.3, 0.0, 1.0,
        ];

        for (i, (&actual, &expected)) in inverted_translate
            .iter()
            .zip(expected_translate.iter())
            .enumerate()
        {
            assert!(
                (actual - expected).abs() < 1e-6,
                "Index {}: {} != {}",
                i,
                actual,
                expected
            );
        }
    }

    #[tokio::test]
    async fn test_capture_single_monitor() {
        let instance = std::time::Instant::now();

        let crop_region = ElementRect {
            min_x: 0,
            min_y: 0,
            max_x: 1000,
            max_y: 1000,
        };

        let monitors = MonitorList::get_by_region(crop_region, true);
        let image = monitors
            .capture_region(
                crop_region,
                None,
                CaptureOption {
                    color_format: ColorFormat::Rgb8,
                    correct_hdr_color_algorithm: CorrectHdrColorAlgorithm::None,
                    correct_color_filter: false,
                    capture_method: CaptureMethod::Wgc,
                },
            )
            .await
            .unwrap();

        image
            .save(
                std::path::PathBuf::from(env::current_dir().unwrap())
                    .join("../../test_output/capture_single_monitor.webp"),
            )
            .unwrap();

        println!("time: {:?}", instance.elapsed());
    }
}
