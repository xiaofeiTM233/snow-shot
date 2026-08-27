use half::prelude::f16;
use rayon::iter::{IntoParallelIterator, ParallelIterator};
use snow_shot_app_shared::ElementRect;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use windows::Win32::Foundation::HWND;
use windows_capture::capture::{Context, GraphicsCaptureApiError, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::{self, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
    SecondaryWindowSettings, Settings,
};

use crate::monitor_info::{ColorFormat, CorrectHdrColorAlgorithm, MonitorInfo};
use image::GenericImageView;

/// 全局标志：标记系统是否支持 DrawBorderSettings::WithoutBorder
/// 默认值为 true，当遇到 BorderConfigUnsupported 错误时会设置为 false
static SUPPORTS_WITHOUT_BORDER: AtomicBool = AtomicBool::new(true);

struct CaptureFlags {
    on_frame_arrived: Sender<(Vec<u8>, usize, usize)>,
    crop_area: Option<ElementRect>,
    capture_is_rgba8: bool,
}

struct WindowsCaptureImage {
    capture_info: Option<CaptureFlags>,
    // 已收到的帧数。切换 capture engine / 颜色格式后 WGC 会话会重建，
    // 首帧常为冷启动空帧（全黑/全零），需丢弃并从后续稳定帧取图。
    frames_seen: u32,
}

impl GraphicsCaptureApiHandler for WindowsCaptureImage {
    type Flags = CaptureFlags;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            capture_info: Some(ctx.flags),
            frames_seen: 0,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        self.frames_seen += 1;
        // 丢弃冷启动首帧，避免「切换配置后首次截图黑屏」
        if self.frames_seen == 1 {
            return Ok(());
        }

        capture_control.stop();

        let capture_info = match self.capture_info.take() {
            Some(capture_info) => capture_info,
            None => {
                return Err(format!(
                    "[WindowsCaptureImage::on_frame_arrived] capture_info is None"
                ));
            }
        };

        // Rgba16F 每个像素占用 8 个字节
        let mut origin_image = frame.buffer().unwrap();

        let origin_image_width = origin_image.width() as usize;
        let origin_image_height = origin_image.height() as usize;
        let origin_image_row_pitch = origin_image.row_pitch() as usize;

        let orgin_image_buffer = origin_image.as_raw_buffer();

        let (min_x, min_y, max_x, max_y) = if let Some(crop_area) = capture_info.crop_area {
            (
                crop_area.min_x,
                crop_area.min_y,
                crop_area.max_x,
                crop_area.max_y,
            )
        } else {
            (0, 0, origin_image_width as i32, origin_image_height as i32)
        };

        let origin_x_offset = min_x as usize;
        let origin_y_offset = min_y as usize;
        let crop_width = (max_x - min_x) as usize;
        let crop_height = (max_y - min_y) as usize;
        let pixels_count = crop_width * crop_height;

        // Rgba16F 每个像素占 8 字节，Rgba8 每个像素占 4 字节
        let pixel_byte_count = if capture_info.capture_is_rgba8 { 4 } else { 8 };
        let mut pixels: Vec<u8> = unsafe {
            let mut pixels = Vec::with_capacity(pixels_count * pixel_byte_count);
            pixels.set_len(pixels_count * pixel_byte_count);
            pixels
        };

        // 使用 row_pitch 而不是 width * pixel_byte_count，因为图像可能有行对齐填充
        let origin_image_buffer_base_index =
            origin_y_offset * origin_image_row_pitch + origin_x_offset * pixel_byte_count;
        let origin_image_buffer_ptr = orgin_image_buffer.as_ptr() as usize;
        let pixels_ptr = pixels.as_mut_ptr() as usize;
        (0..crop_height).into_par_iter().for_each(|y| {
            let origin_image_index = origin_image_buffer_base_index + y * origin_image_row_pitch;
            let target_image_index = y * crop_width * pixel_byte_count;

            unsafe {
                std::ptr::copy_nonoverlapping(
                    (origin_image_buffer_ptr as *const u8).add(origin_image_index),
                    (pixels_ptr as *mut u8).add(target_image_index),
                    crop_width * pixel_byte_count,
                );
            }
        });

        match capture_info
            .on_frame_arrived
            .send((pixels, crop_width, crop_height))
        {
            Ok(()) => Ok(()),
            Err(_) => {
                log::error!("[WindowsCaptureImage::on_frame_arrived] failed to send pixels");

                Err(format!(
                    "[WindowsCaptureImage::on_frame_arrived] failed to send pixels"
                ))
            }
        }
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// 将线性颜色值转换为 sRGB 颜色值
#[inline]
fn linear_to_srgb_byte(linear: f32) -> u8 {
    let srgb = if linear <= 0.0031308 {
        12.92 * linear
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    };

    if srgb < 0.0 {
        0
    } else if srgb > 1.0 {
        255
    } else {
        (srgb * 255.0) as u8
    }
}

#[inline]
pub fn write_rgba16f_linear_to_rgb8(
    rgba16f_image: *const u8,
    rgb8_image: *mut u8,
    hdr_scale: f32,
    pixel_index: usize,
) {
    unsafe {
        let red_f = f16::from_bits(u16::from_le(
            *(rgba16f_image.add(pixel_index * 8) as *const u16),
        ))
        .to_f32()
            * hdr_scale;
        let green_f = f16::from_bits(u16::from_le(
            *(rgba16f_image.add(pixel_index * 8 + 2) as *const u16),
        ))
        .to_f32()
            * hdr_scale;
        let blue_f = f16::from_bits(u16::from_le(
            *(rgba16f_image.add(pixel_index * 8 + 4) as *const u16),
        ))
        .to_f32()
            * hdr_scale;

        // 使用快速饱和转换
        rgb8_image
            .add(pixel_index * 3)
            .write(linear_to_srgb_byte(red_f));
        rgb8_image
            .add(pixel_index * 3 + 1)
            .write(linear_to_srgb_byte(green_f));
        rgb8_image
            .add(pixel_index * 3 + 2)
            .write(linear_to_srgb_byte(blue_f));
    }
}

#[inline]
pub fn write_rgba16f_linear_to_rgba8(
    rgba16f_image: *const u8,
    rgba8_image: *mut u8,
    hdr_scale: f32,
    pixel_index: usize,
) {
    unsafe {
        let red_f = f16::from_bits(u16::from_le(
            *(rgba16f_image.add(pixel_index * 8) as *const u16),
        ))
        .to_f32()
            * hdr_scale;
        let green_f = f16::from_bits(u16::from_le(
            *(rgba16f_image.add(pixel_index * 8 + 2) as *const u16),
        ))
        .to_f32()
            * hdr_scale;
        let blue_f = f16::from_bits(u16::from_le(
            *(rgba16f_image.add(pixel_index * 8 + 4) as *const u16),
        ))
        .to_f32()
            * hdr_scale;

        // 使用快速饱和转换
        rgba8_image
            .add(pixel_index * 4)
            .write(linear_to_srgb_byte(red_f));
        rgba8_image
            .add(pixel_index * 4 + 1)
            .write(linear_to_srgb_byte(green_f));
        rgba8_image
            .add(pixel_index * 4 + 2)
            .write(linear_to_srgb_byte(blue_f));
        // 截图不需要透明通道。HDR(WGC Rgba16F) 捕获帧的 Alpha 通常为 0，
        // 若直接写入会导致整幅图像透明、预览/保存显示为黑屏，因此强制不透明。
        rgba8_image.add(pixel_index * 4 + 3).write(255);
    }
}

/// 判断一张图像是否「全黑 / 近全黑」。
/// 采样像素并统计明度接近 0 的比例，超过阈值即视为黑屏帧。
/// 注意：纯黑桌面（用户背景本来就是黑的）也会被命中，但截图场景里
/// 显示器全黑基本都意味着捕获失败（冷启动空帧 / DRM 保护 / 设备冲突），
/// 因此宁可误杀也优先重试，避免把黑屏带进结果。
fn is_black_image(image: &image::DynamicImage, black_ratio_threshold: f32) -> bool {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return true;
    }

    // 步进取样，避免大图逐像素扫描开销
    let step = ((width * height) as usize / 4000).max(1) as u32;
    let mut sampled = 0u32;
    let mut black = 0u32;

    for y in (0..height).step_by(step as usize) {
        for x in (0..width).step_by(step as usize) {
            let pixel = image.get_pixel(x, y);
            sampled += 1;
            // 取 RGB 均值作为明度近似，< 8 (≈3%) 视为黑像素
            let r = pixel[0] as u32;
            let g = pixel[1] as u32;
            let b = pixel[2] as u32;
            let lum = (r + g + b) / 3;
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

/// 处理捕获的图像数据
/// capture_is_rgba8 表示底层 windows-capture 捕获到的是 Rgba8（普通 SDR 显示器）而非 Rgba16F（HDR），
/// 此时无需做 HDR 线性转换，直接按 RGBA8 复制即可。
fn process_captured_image(
    receiver: std::sync::mpsc::Receiver<(Vec<u8>, usize, usize)>,
    monitor: &MonitorInfo,
    color_format: ColorFormat,
    algorithm: CorrectHdrColorAlgorithm,
    capture_is_rgba8: bool,
) -> Result<image::DynamicImage, String> {
    let (rgba16f_image, image_width, image_height) = match receiver.recv() {
        Ok(image) => image,
        Err(e) => {
            return Err(format!(
                "[windows_capture_image::process_captured_image] failed to receive image: {:?}",
                e
            ));
        }
    };

    let pixel_len = match color_format {
        ColorFormat::Rgb8 => 3,
        ColorFormat::Rgba8 => 4,
    };

    let result_image_pixels_count = image_width * image_height;
    let mut image_pixels: Vec<u8> = unsafe {
        let mut image_pixels = Vec::with_capacity(result_image_pixels_count * pixel_len);
        image_pixels.set_len(result_image_pixels_count * pixel_len);
        image_pixels
    };

    // hdr_scale 决定 HDR 亮度如何压回 SDR 显示范围：
    // - 软件未开启 HDR 颜色校正（algorithm == None）时不缩放（视为普通 SDR 渲染）
    // - sdr_white_level == 0 表示 HDR 未真正激活（宽色域 SDR 或读取失败）时也不缩放
    // - 真正开启 HDR 校正且白电平有效时用 1000 / sdr_white_level 压缩
    let hdr_scale = if algorithm == CorrectHdrColorAlgorithm::None
        || monitor.monitor_hdr_info.sdr_white_level == 0
    {
        1.0
    } else {
        1000.0 / (monitor.monitor_hdr_info.sdr_white_level as f32)
    };

    let image_pixels_ptr = image_pixels.as_mut_ptr() as usize;
    let rgba16f_image_ptr = rgba16f_image.as_ptr() as usize;

    // 走系统合成的 Rgba8 捕获（未开启 HDR 颜色校正，或开启但系统 HDR 当前关闭）：
    // 数据是普通 8 位 RGBA（已是显示就绪的 sRGB），无需 HDR 线性转换，直接构造图像返回。
    if capture_is_rgba8 {
        let rgba8 = match image::RgbaImage::from_raw(
            image_width as u32,
            image_height as u32,
            rgba16f_image,
        ) {
            Some(img) => img,
            None => {
                return Err(format!(
                    "[windows_capture_image::process_captured_image] Failed to create rgba8 image from Rgba8 capture"
                ));
            }
        };
        // 同理强制不透明：系统合成 Rgba8 帧的 Alpha 偶尔为 0，会导致黑屏。
        let mut rgba8 = rgba8;
        for p in rgba8.pixels_mut() {
            p.0[3] = 255;
        }
        return Ok(image::DynamicImage::ImageRgba8(rgba8));
    }

    match color_format {
        ColorFormat::Rgb8 => {
            (0..result_image_pixels_count)
                .into_par_iter()
                .for_each(|i| {
                    write_rgba16f_linear_to_rgb8(
                        rgba16f_image_ptr as *const u8,
                        image_pixels_ptr as *mut u8,
                        hdr_scale,
                        i,
                    );
                });

            match image::RgbImage::from_raw(image_width as u32, image_height as u32, image_pixels) {
                Some(rgb8_image) => Ok(image::DynamicImage::ImageRgb8(rgb8_image)),
                None => Err(format!(
                    "[windows_capture_image::process_captured_image] Failed to create rgb8 image"
                )),
            }
        }
        ColorFormat::Rgba8 => {
            (0..result_image_pixels_count)
                .into_par_iter()
                .for_each(|i| {
                    write_rgba16f_linear_to_rgba8(
                        rgba16f_image_ptr as *const u8,
                        image_pixels_ptr as *mut u8,
                        hdr_scale,
                        i,
                    );
                });

            match image::RgbaImage::from_raw(image_width as u32, image_height as u32, image_pixels)
            {
                Some(rgba8_image) => {
                    Ok(image::DynamicImage::ImageRgba8(rgba8_image))
                }
                None => Err(format!(
                    "[windows_capture_image::process_captured_image] Failed to create rgba8 image"
                )),
            }
        }
    }
}

pub fn capture_monitor_image(
    monitor: &MonitorInfo,
    window: Option<HWND>,
    crop_area: Option<ElementRect>,
    color_format: ColorFormat,
    algorithm: CorrectHdrColorAlgorithm,
) -> Result<image::DynamicImage, String> {
    // WGC 的 windows-capture 会在调用线程上执行 RoInitialize(RO_INIT_MULTITHREADED)，
    // 若该线程已被 Tauri/WebView2/其他库初始化为 STA，会返回 RPC_E_CHANGED_MODE
    // 导致 FailedToInitWinRT（冷启动首次截图黑屏的根因）。
    // 修复：在干净的新线程上执行 WGC（新线程 COM 状态干净，RoInitialize 必然成功），
    // 主线程等待结果。MonitorInfo 已 unsafe impl Send，可安全 move 进线程。
    let caller_thread_id = std::thread::current().id();
    log::info!(
        "[windows_capture_image::capture_monitor_image] spawning wgc thread, caller thread: {:?}, hdr_enabled: {}, capture_is_rgba8: {}",
        caller_thread_id,
        monitor.monitor_hdr_info.hdr_enabled,
        !(algorithm != CorrectHdrColorAlgorithm::None && monitor.monitor_hdr_info.hdr_enabled)
    );

    // 诊断：探测调用线程的 WinRT 初始化状态（不改变它，只观察）。
    // RoInitialize 会改变线程状态，这里探测后立即 RoUninitialize 还原，避免副作用。
    probe_winrt_thread_state("caller");

    let monitor_clone = monitor.clone();
    // HWND 是 *mut c_void 裸指针，不是 Send，不能直接 move 进线程。
    // 转成 isize（指针整数）传输，在线程内恢复为 HWND（HWND 是只读句柄，跨线程安全）。
    let window_clone = window.map(|w| w.0 as isize);
    let crop_area_clone = crop_area;
    let (tx, rx) = channel::<Result<image::DynamicImage, String>>();

    std::thread::Builder::new()
        .name("wgc-capture-thread".to_string())
        .spawn(move || {
            log::info!(
                "[windows_capture_image::capture_monitor_image] wgc thread started, thread: {:?}",
                std::thread::current().id()
            );
            probe_winrt_thread_state("wgc-thread");
            let window_restored = window_clone.map(|w| HWND(w as *mut core::ffi::c_void));
            let result = capture_monitor_image_impl(
                &monitor_clone,
                window_restored,
                crop_area_clone,
                color_format,
                algorithm,
            );
            match &result {
                Ok(_) => log::info!(
                    "[windows_capture_image::capture_monitor_image] wgc thread done OK, thread: {:?}",
                    std::thread::current().id()
                ),
                Err(e) => log::error!(
                    "[windows_capture_image::capture_monitor_image] wgc thread returned error, thread: {:?}, err: {}",
                    std::thread::current().id(),
                    e
                ),
            }
            let _ = tx.send(result);
        })
        .map_err(|e| {
            format!(
                "[windows_capture_image::capture_monitor_image] failed to spawn wgc thread: {:?}",
                e
            )
        })?;

    match rx.recv() {
        Ok(result) => result,
        Err(e) => Err(format!(
            "[windows_capture_image::capture_monitor_image] failed to join wgc thread: {:?}",
            e
        )),
    }
}

/// 诊断：探测当前线程的 WinRT 初始化状态并打日志。
/// 通过尝试 RoInitialize(RO_INIT_MULTITHREADED) 观察返回值，随后 RoUninitialize 还原，
/// 以便判断线程是否已被 STA 初始化（返回 RPC_E_CHANGED_MODE 即说明是 STA）。
fn probe_winrt_thread_state(tag: &str) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
        let thread_id = std::thread::current().id();
        let hr = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
        let (hr_code, description) = match &hr {
            Ok(_) => (0x00000000, "MTA/OK"),
            Err(e) => {
                let code = e.code().0;
                if code == 0x80010106 {
                    // RPC_E_CHANGED_MODE
                    (code, "RPC_E_CHANGED_MODE: thread is STA, WGC will fail on this thread")
                } else if code == 0x00000001 {
                    // S_FALSE：已初始化（RoInitialize 不会返回 S_FALSE，但保留判断）
                    (code, "S_FALSE/already initialized")
                } else {
                    (code, "other error")
                }
            }
        };
        log::info!(
            "[probe_winrt] {} thread: {:?}, RoInitialize(MTA) hr: 0x{:08X} ({})",
            tag,
            thread_id,
            hr_code as u32,
            description
        );
        // 探测后还原线程状态。RoInitialize 成功后必须 RoUninitialize，避免影响后续
        // windows-capture 在同一线程上的 RoInitialize（否则它会认为已初始化而走 S_FALSE 分支）。
        if hr.is_ok() {
            unsafe { RoUninitialize() };
        }
    }
}

fn capture_monitor_image_impl(
    monitor: &MonitorInfo,
    window: Option<HWND>,
    crop_area: Option<ElementRect>,
    color_format: ColorFormat,
    algorithm: CorrectHdrColorAlgorithm,
) -> Result<image::DynamicImage, String> {
    // 是否使用 Rgba16F 取决于"是否开启 HDR 颜色校正"且"系统 HDR 当前开启"：
    // - 未开启校正（algorithm == None）：全部走系统合成的 Rgba8 直拷，损失就损失，简单稳定；
    // - 开启校正且系统 HDR 开启：用 Rgba16F 捕获线性帧并做亮度校正，不损失 HDR 信息；
    // - 开启校正但系统 HDR 关闭：退化 Rgba8 直拷（避免 windows-capture 在 SDR 模式用
    //   Rgba16F 截到黑帧，这是关闭系统 HDR 后黑屏的根因）。
    // 注意：不能用 sdr_white_level 判断，它返回的是面板硬件能力（与系统 HDR 开关无关，
    // 关掉 HDR 后仍为硬件固定值 > 0），无法反映"当前是否为 SDR 模式"。
    let capture_is_rgba8 = !(algorithm != CorrectHdrColorAlgorithm::None
        && monitor.monitor_hdr_info.hdr_enabled);
    let capture_color_format = if capture_is_rgba8 {
        windows_capture::settings::ColorFormat::Rgba8
    } else {
        windows_capture::settings::ColorFormat::Rgba16F
    };

    log::info!(
        "[windows_capture_image::capture_monitor_image_impl] hdr_enabled: {}, sdr_white_level: {}, capture_is_rgba8: {}",
        monitor.monitor_hdr_info.hdr_enabled,
        monitor.monitor_hdr_info.sdr_white_level,
        capture_is_rgba8
    );

    let (sender, receiver) = channel();

    // 根据全局标志选择边框设置
    let draw_border_setting = if SUPPORTS_WITHOUT_BORDER.load(Ordering::Relaxed) {
        DrawBorderSettings::WithoutBorder
    } else {
        DrawBorderSettings::Default
    };

    let capture_monitor =
        Monitor::from_raw_hmonitor(MonitorInfo::get_monitor_handle(&monitor.monitor).0);
    let window = match window {
        Some(window) => Some(windows_capture::window::Window::from_raw_hwnd(window.0)),
        None => None,
    };

    let start_result: Result<(), GraphicsCaptureApiError<String>> = match window {
        Some(window) => {
            let settings = Settings::new(
                window,
                CursorCaptureSettings::WithoutCursor,
                draw_border_setting,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                capture_color_format,
                CaptureFlags {
                    on_frame_arrived: sender,
                    crop_area,
                    capture_is_rgba8,
                },
            );

            WindowsCaptureImage::start(settings)
        }
        None => {
            let settings = Settings::new(
                capture_monitor,
                CursorCaptureSettings::WithoutCursor,
                draw_border_setting,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                capture_color_format,
                CaptureFlags {
                    on_frame_arrived: sender,
                    crop_area,
                    capture_is_rgba8,
                },
            );

            WindowsCaptureImage::start(settings)
        }
    };

    // 尝试启动捕获器。捕获成功后做黑屏检测，命中则按 BLACK_RETRY_TIMES 重试。

    // 黑屏检测阈值：采样像素中 ≥ 99% 为近黑即判定为黑屏帧
    const BLACK_RATIO_THRESHOLD: f32 = 0.99;
    // 单显示器最多重试次数（不含首次）
    const BLACK_RETRY_TIMES: u32 = 3;

    match start_result {
        Ok(_capturer) => {
            // 启动成功，处理捕获的图像
            let mut image = process_captured_image(
                receiver,
                monitor,
                color_format,
                algorithm,
                capture_is_rgba8,
            )?;

            // 黑屏检测 + 重试：WGC 冷启动空帧、DRM 保护、设备冲突都可能截到全黑，
            // 重试一次通常能拿到正常帧。
            for attempt in 1..=BLACK_RETRY_TIMES {
                if !is_black_image(&image, BLACK_RATIO_THRESHOLD) {
                    return Ok(image);
                }
                log::warn!(
                    "[windows_capture_image::capture_monitor_image] detected black frame (attempt {}), retrying WGC capture",
                    attempt
                );
                let (retry_sender, retry_receiver) = channel();
                let retry_result: Result<(), GraphicsCaptureApiError<String>> = match window {
                    Some(window) => WindowsCaptureImage::start(Settings::new(
                        window,
                        CursorCaptureSettings::WithoutCursor,
                        draw_border_setting,
                        SecondaryWindowSettings::Default,
                        MinimumUpdateIntervalSettings::Default,
                        DirtyRegionSettings::Default,
                        capture_color_format,
                        CaptureFlags {
                            on_frame_arrived: retry_sender,
                            crop_area,
                            capture_is_rgba8,
                        },
                    )),
                    None => WindowsCaptureImage::start(Settings::new(
                        capture_monitor,
                        CursorCaptureSettings::WithoutCursor,
                        draw_border_setting,
                        SecondaryWindowSettings::Default,
                        MinimumUpdateIntervalSettings::Default,
                        DirtyRegionSettings::Default,
                        capture_color_format,
                        CaptureFlags {
                            on_frame_arrived: retry_sender,
                            crop_area,
                            capture_is_rgba8,
                        },
                    )),
                };
                match retry_result {
                    Ok(_) => {
                        image = process_captured_image(
                            retry_receiver,
                            monitor,
                            color_format,
                            algorithm,
                            capture_is_rgba8,
                        )?;
                    }
                    Err(retry_e) => {
                        log::error!(
                            "[windows_capture_image::capture_monitor_image] WGC retry start failed: {:?}",
                            retry_e
                        );
                        return Err(format!(
                            "[windows_capture_image::capture_monitor_image] failed to start capturer on retry: {:?}",
                            retry_e
                        ));
                    }
                }
            }

            // 重试耗尽仍黑屏：记录并仍返回最后一帧（交由上层决定是否回退 xcap）
            if is_black_image(&image, BLACK_RATIO_THRESHOLD) {
                log::error!(
                    "[windows_capture_image::capture_monitor_image] still black after {} retries, returning last frame",
                    BLACK_RETRY_TIMES
                );
            }
            Ok(image)
        }
        Err(e) => match e {
            GraphicsCaptureApiError::GraphicsCaptureApiError(
                graphics_capture_api::Error::BorderConfigUnsupported,
            ) => {
                log::warn!(
                    "[windows_capture_image::capture_monitor_image] BorderConfigUnsupported detected, falling back to Default border setting"
                );

                // 标记系统不支持 WithoutBorder，后续请求将直接使用 Default
                SUPPORTS_WITHOUT_BORDER.store(false, Ordering::Relaxed);

                // 使用 Default 设置重试
                let (retry_sender, retry_receiver) = channel();

                let start_result: Result<(), GraphicsCaptureApiError<String>> = match window {
                    Some(window) => {
                        let settings = Settings::new(
                            window,
                            CursorCaptureSettings::WithoutCursor,
                            draw_border_setting,
                            SecondaryWindowSettings::Default,
                            MinimumUpdateIntervalSettings::Default,
                            DirtyRegionSettings::Default,
                            capture_color_format,
                            CaptureFlags {
                                on_frame_arrived: retry_sender,
                                crop_area,
                                capture_is_rgba8,
                            },
                        );

                        WindowsCaptureImage::start(settings)
                    }
                    None => {
                        let settings = Settings::new(
                            capture_monitor.clone(),
                            CursorCaptureSettings::WithoutCursor,
                            draw_border_setting,
                            SecondaryWindowSettings::Default,
                            MinimumUpdateIntervalSettings::Default,
                            DirtyRegionSettings::Default,
                            capture_color_format,
                            CaptureFlags {
                                on_frame_arrived: retry_sender,
                                crop_area,
                                capture_is_rgba8,
                            },
                        );

                        WindowsCaptureImage::start(settings)
                    }
                };

                // 重试启动捕获器
                match start_result {
                    Ok(_capturer) => {
                        // 重试成功，处理捕获的图像
                        let image = process_captured_image(
                            retry_receiver,
                            monitor,
                            color_format,
                            algorithm,
                            capture_is_rgba8,
                        )?;
                        // BorderConfigUnsupported 回退路径同样做黑屏检测
                        if is_black_image(&image, 0.99) {
                            log::warn!(
                                "[windows_capture_image::capture_monitor_image] detected black frame after BorderConfig fallback, returning (may fall back to xcap)"
                            );
                        }
                        Ok(image)
                    }
                    Err(retry_e) => {
                        // 重试失败，本次回退到 xcap（由上层处理），不永久禁用 WGC
                        log::error!(
                            "[windows_capture_image::capture_monitor_image] HDR image capture failed after retry: {:?}",
                            retry_e
                        );

                        Err(format!(
                            "[windows_capture_image::capture_monitor_image] failed to start capturer after retry: {:?}",
                            retry_e
                        ))
                    }
                }
            }
            _ => {
                // 本次 WGC 启动失败，回退到 xcap（由上层处理），不永久禁用 WGC
                log::error!(
                    "[windows_capture_image::capture_monitor_image] HDR image capture failed: {:?}",
                    e
                );

                Err(format!(
                    "[windows_capture_image::capture_monitor_image] failed to start capturer: {:?}",
                    e
                ))
            }
        },
    }
}
