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
}

impl GraphicsCaptureApiHandler for WindowsCaptureImage {
    type Flags = CaptureFlags;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            capture_info: Some(ctx.flags),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
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
        let alpha_f = f16::from_bits(u16::from_le(
            *(rgba16f_image.add(pixel_index * 8 + 6) as *const u16),
        ))
        .to_f32();

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
        // Alpha 通道不需要 linear_to_srgb 转换，直接钳位到 [0, 1] 范围
        rgba8_image
            .add(pixel_index * 4 + 3)
            .write((alpha_f.clamp(0.0, 1.0) * 255.0) as u8);
    }
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

    // 非真 HDR 显示器（sdr_white_level == 0，宽色域 SDR / HDR 系统开关关闭）使用 Rgba8 捕获，
    // 数据为普通 8 位 RGBA，无需 HDR 线性转换，直接构造图像返回。
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
    // 非真 HDR 显示器（sdr_white_level == 0，宽色域 SDR / HDR 系统开关关闭）使用 Rgba8 捕获，
    // 因为 windows-capture 在 SDR 显示器上使用 Rgba16F 会截到黑帧；
    // 真正 HDR 显示器（白电平有效）才使用 Rgba16F 并做亮度校正。
    let capture_is_rgba8 = monitor.monitor_hdr_info.sdr_white_level == 0;
    let capture_color_format = if capture_is_rgba8 {
        windows_capture::settings::ColorFormat::Rgba8
    } else {
        windows_capture::settings::ColorFormat::Rgba16F
    };

    log::info!(
        "[windows_capture_image::capture_monitor_image] hdr_enabled: {}, sdr_white_level: {}, capture_is_rgba8: {}",
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

    // 尝试启动捕获器

    match start_result {
        Ok(_capturer) => {
            // 启动成功，处理捕获的图像
            process_captured_image(receiver, monitor, color_format, algorithm, capture_is_rgba8)
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
                        process_captured_image(retry_receiver, monitor, color_format, algorithm, capture_is_rgba8)
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
