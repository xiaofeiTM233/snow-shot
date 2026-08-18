use rayon::iter::{IntoParallelIterator, ParallelIterator};
use std::ffi::OsStr;
use std::path::PathBuf;
use tauri::http::HeaderValue;
use tokio::fs;

use base64::prelude::*;
use device_query::{DeviceQuery, DeviceState, MouseState};
use image::codecs::avif::AvifEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, GenericImageView};
use snow_shot_app_shared::ElementRect;
use tauri::AppHandle;
use xcap::Monitor;
use zune_core::bit_depth::BitDepth;
use zune_core::colorspace::ColorSpace;
use zune_core::options::EncoderOptions;
use zune_jpegxl::JxlSimpleEncoder;

use crate::monitor_info::{ColorFormat, MonitorList};

#[cfg(target_os = "windows")]
pub mod monitor_hdr_info;
#[cfg(target_os = "windows")]
pub mod windows_capture_image;

/// 平台相关的底层工具（本地化定制能力，与 xcap 解耦）。
pub mod sys;

pub mod monitor_info;

pub fn get_device_state() -> Result<DeviceState, String> {
    #[cfg(target_os = "macos")]
    {
        if !macos_accessibility_client::accessibility::application_is_trusted() {
            return Err(format!("[get_device_state] Accessibility is not enabled"));
        }
    }

    Ok(DeviceState::new())
}

pub fn get_device_mouse_position() -> Result<(i32, i32), String> {
    let device_state = get_device_state()?;
    let mouse: MouseState = device_state.get_mouse();

    Ok(mouse.coords)
}

pub fn get_target_monitor() -> Result<(i32, i32, Monitor), String> {
    let (mut mouse_x, mut mouse_y) = match get_device_mouse_position() {
        Ok((x, y)) => (x, y),
        Err(e) => {
            return Err(format!(
                "[get_target_monitor] Failed to get device mouse position: {}",
                e
            ));
        }
    };
    let monitor = Monitor::from_point(mouse_x, mouse_y).unwrap_or_else(|_| {
        // 在 Wayland 中，获取不到鼠标位置，选用第一个显示器作为位置

        log::warn!("[get_target_monitor] No monitor found, using first monitor");

        let monitor_list = xcap::Monitor::all().expect("[get_target_monitor] No monitor found");
        let first_monitor = monitor_list
            .first()
            .expect("[get_target_monitor] No monitor found");

        mouse_x = first_monitor.x().unwrap_or(0) + first_monitor.width().unwrap_or(0) as i32 / 2;
        mouse_y = first_monitor.y().unwrap_or(0) + first_monitor.height().unwrap_or(0) as i32 / 2;

        first_monitor.clone()
    });

    Ok((mouse_x, mouse_y, monitor))
}

pub async fn save_image_to_file(
    image: &image::DynamicImage,
    file_path: PathBuf,
) -> Result<(), String> {
    // 确保文件路径的父目录存在
    if let Some(parent_dir) = file_path.parent() {
        if !parent_dir.exists() {
            match fs::create_dir_all(parent_dir).await {
                Ok(_) => {
                    log::info!(
                        "[save_image_to_file] Created directory: {}",
                        parent_dir.display()
                    );
                }
                Err(e) => {
                    return Err(format!(
                        "[save_image_to_file] Failed to create directory {}: {}",
                        parent_dir.display(),
                        e
                    ));
                }
            }
        }
    }

    let extension = match file_path.extension() {
        Some(extension) => extension,
        None => {
            log::warn!("[save_image_to_file] No extension found, using default extension");

            OsStr::new("")
        }
    };

    if extension == "jxl" {
        let has_alpha = image.color().has_alpha();
        let (width, height) = image.dimensions();
        let image_data = if has_alpha {
            DynamicImage::ImageRgba8(image.to_rgba8())
        } else {
            DynamicImage::ImageRgb8(image.to_rgb8())
        };
        let encoder = JxlSimpleEncoder::new(
            image_data.as_bytes(),
            EncoderOptions::new(
                width as usize,
                height as usize,
                if has_alpha {
                    ColorSpace::RGBA
                } else {
                    ColorSpace::RGB
                },
                BitDepth::Eight,
            ),
        );
        let encoder_result = match encoder.encode() {
            Ok(encoder_result) => encoder_result,
            Err(_) => {
                return Err(format!(
                    "[save_image_to_file] Failed to encode image: {}",
                    file_path.display()
                ));
            }
        };

        return match fs::write(file_path.clone(), encoder_result).await {
            Ok(_) => Ok(()),
            Err(e) => Err(format!(
                "[save_image_to_file] Failed to save image to file: {} {}",
                e,
                file_path.display(),
            )),
        };
    } else {
        // jpg 是 RGB 格式，所以需要转换为 RGB 格式
        let image = if image.color().has_alpha() && extension == "jpg" {
            &DynamicImage::ImageRgb8(image.to_rgb8())
        } else {
            image
        };

        match image.save(file_path.clone()) {
            Ok(_) => (),
            Err(e) => {
                return Err(format!(
                    "[save_image_to_file] Failed to save image to file: {} {}",
                    e,
                    file_path.display(),
                ));
            }
        }
    }

    return Ok(());
}

pub fn get_mouse_position(
    #[allow(unused_variables)] app: &AppHandle,
) -> Result<(i32, i32), String> {
    let device_state = get_device_state()?;
    let mouse: MouseState = device_state.get_mouse();
    let (mouse_x, mouse_y) = mouse.coords;

    #[cfg(target_os = "macos")]
    let mut position_scale = 1.0;
    #[cfg(not(target_os = "macos"))]
    let position_scale = 1.0;

    // macOS 下的鼠标位置是基于逻辑像素
    #[cfg(target_os = "macos")]
    {
        if let Ok(Some(monitor)) = app.monitor_from_point(mouse_x as f64, mouse_y as f64) {
            position_scale = monitor.scale_factor();
        }
    }

    Ok((
        (mouse_x as f64 * position_scale) as i32,
        (mouse_y as f64 * position_scale) as i32,
    ))
}

pub fn get_capture_monitor_list(
    #[allow(unused_variables)] app: &AppHandle,
    region: Option<ElementRect>,
    enable_multiple_monitor: bool,
    ignore_sdr_info: bool,
) -> Result<MonitorList, String> {
    if let Some(region) = region {
        return Ok(MonitorList::get_by_region(region, ignore_sdr_info));
    }

    let support_multiple_monitor;

    #[cfg(target_os = "windows")]
    {
        support_multiple_monitor = true;
    }

    #[cfg(target_os = "macos")]
    {
        // 检查所有显示器的 scale_factor 是否一致
        let (all_same_scale, _) = check_monitor_scale_factors_consistent();

        // 此时支持跨屏截图，如果 scale_factor 不一致，则需要根据鼠标位置获取单个显示器进行截图
        if all_same_scale {
            support_multiple_monitor = true;
        } else {
            support_multiple_monitor = false;
        }
    }

    if enable_multiple_monitor && support_multiple_monitor {
        Ok(MonitorList::all(ignore_sdr_info))
    } else {
        let (mouse_x, mouse_y) = get_mouse_position(app)?;
        Ok(MonitorList::get_by_region(
            ElementRect {
                min_x: mouse_x,
                min_y: mouse_y,
                max_x: mouse_x,
                max_y: mouse_y,
            },
            ignore_sdr_info,
        ))
    }
}

/// 检查所有显示器的 scale_factor 是否一致
///
/// 返回一个元组：(是否一致, 所有 scale_factor 的列表)
/// 如果只有一个显示器，则认为是一致的
#[cfg(target_os = "macos")]
pub fn check_monitor_scale_factors_consistent() -> (bool, Vec<f32>) {
    let scale_factors: Vec<f32> = xcap::Monitor::all()
        .unwrap_or_default()
        .iter()
        .map(|monitor| monitor.scale_factor().unwrap_or(1.0))
        .collect();

    let all_same_scale = if scale_factors.len() > 1 {
        let first_scale = scale_factors[0];
        scale_factors
            .iter()
            .all(|&scale| (scale - first_scale).abs() < f32::EPSILON)
    } else {
        true // 只有一个显示器时认为是一致的
    };

    (all_same_scale, scale_factors)
}

pub fn capture_target_monitor(
    monitor: &Monitor,
    crop_area: Option<ElementRect>,
    #[allow(unused_variables)] exclude_window: Option<&tauri::Window>,
    #[allow(unused_variables)] color_format: ColorFormat,
) -> Option<image::DynamicImage> {
    #[cfg(target_os = "windows")]
    {
        // 官方 xcap 0.9.8 只提供返回 RGBA 的 capture_image()/capture_region()，
        // 不再有 *_rgb 变体。ColorFormat::Rgb8 时先取 RGBA 再转 RGB。
        let image = if let Some(crop_area) = crop_area {
            match monitor.capture_region(
                crop_area.min_x as u32,
                crop_area.min_y as u32,
                (crop_area.max_x - crop_area.min_x) as u32,
                (crop_area.max_y - crop_area.min_y) as u32,
            ) {
                Ok(rgba) => match color_format {
                    ColorFormat::Rgb8 => {
                        DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(rgba).to_rgb8())
                    }
                    ColorFormat::Rgba8 => DynamicImage::ImageRgba8(rgba),
                },
                Err(e) => {
                    log::error!(
                        "[capture_target_monitor] failed to capture image: {:?}",
                        e
                    );
                    return None;
                }
            }
        } else {
            match monitor.capture_image() {
                Ok(rgba) => match color_format {
                    ColorFormat::Rgb8 => {
                        DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(rgba).to_rgb8())
                    }
                    ColorFormat::Rgba8 => DynamicImage::ImageRgba8(rgba),
                },
                Err(e) => {
                    log::error!("[capture_target_monitor] failed to capture image: {:?}", e);
                    return None;
                }
            }
        };

        return Some(image);
    }

    #[cfg(target_os = "macos")]
    {
        // macOS 截图统一改用官方 xcap（不再依赖 mg-chao/scap fork）。
        // 说明：
        // - 屏幕录制权限由 xcap 在 capture 时隐式要求，失败时返回 Err，这里转为 None。
        // - xcap 不提供「排除指定窗口」能力，因此忽略 exclude_window（与 Windows WGC
        //   排除行为存在差异，后续如需 macOS 排除自身窗口可在上层用遮挡/裁剪规避）。
        if monitor
            .name()
            .unwrap_or_default()
            .eq("DeskPad Display")
        {
            log::warn!("[capture_target_monitor] skip DeskPad Display");
            return Some(image::DynamicImage::ImageRgba8(image::RgbaImage::new(1, 1)));
        }

        let capture_result = if let Some(crop_area) = crop_area {
            monitor.capture_region(
                crop_area.min_x as u32,
                crop_area.min_y as u32,
                (crop_area.max_x - crop_area.min_x) as u32,
                (crop_area.max_y - crop_area.min_y) as u32,
            )
        } else {
            monitor.capture_image()
        };

        match capture_result {
            Ok(rgba) => Some(image::DynamicImage::ImageRgba8(rgba)),
            Err(e) => {
                log::error!("[capture_target_monitor] macOS xcap capture failed: {:?}", e);
                None
            }
        }
    }
}

pub enum ImageEncoder {
    Webp,
    Png,
    Avif,
    Jpeg,
}

pub fn encode_image(
    image: &image::DynamicImage,
    encoder: ImageEncoder,
) -> Result<Vec<u8>, image::ImageError> {
    // 编码为指定格式
    let mut buf = Vec::with_capacity(image.as_bytes().len() / 8);

    match encoder {
        ImageEncoder::Jpeg => {
            image.write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 80))?;
        }
        ImageEncoder::Webp => {
            image.write_with_encoder(WebPEncoder::new_lossless(&mut buf))?;
        }
        ImageEncoder::Png => {
            image.write_with_encoder(PngEncoder::new_with_quality(
                &mut buf,
                CompressionType::Fast,
                FilterType::Paeth,
            ))?;
        }
        ImageEncoder::Avif => {
            image.write_with_encoder(AvifEncoder::new_with_speed_quality(&mut buf, 10, 80))?;
        }
    }

    Ok(buf)
}

/// 将一个图像绘制到另一个图像上
///
/// # Arguments
///
/// - `image_pixels` (`&mut [u8]`) - 合并后的图像像素数据
/// - `target_pixels` (`&[u8]`) - 待合并的图像的像素数组
/// - `offset_x` (`i64`) - 待合并的图像在合并后的图像上的偏移量
/// - `offset_y` (`i64`) - 待合并的图像在合并后的图像上的偏移量
///
/// ```
pub fn overlay_image_ptr(
    image_pixels: *mut u8,
    image_width: usize,
    target_image: &image::DynamicImage,
    offset_x: usize,
    offset_y: usize,
    channel_count: usize,
) {
    let image_pixels_ptr = image_pixels as usize;

    let target_image_width = target_image.width() as usize;
    let target_image_height = target_image.height() as usize;
    // 源图像自身的真实通道数（如 Rgba8 为 4），必须与步进字节数一致，
    // 不能用目标合并图的 channel_count，否则源每像素步长算错导致逐行错位（花屏）。
    let target_image_channel_count = target_image.color().channel_count() as usize;
    let target_image_pixels = target_image.as_bytes();
    let target_image_pixels_ptr = target_image_pixels.as_ptr() as usize;

    let image_base_index = offset_y * image_width * channel_count + offset_x * channel_count;

    // 多线程提升较小
    // 先保留
    (0..target_image_height)
        .into_par_iter()
        .for_each(|y| unsafe {
            let image_row_ptr = (image_pixels_ptr as *mut u8)
                .add(image_base_index + y * image_width * channel_count);
            let target_image_row_ptr = (target_image_pixels_ptr as *mut u8)
                .add(y * target_image_width * target_image_channel_count);

            std::ptr::copy_nonoverlapping(
                target_image_row_ptr,
                image_row_ptr,
                target_image_width * channel_count,
            );
        });
}

pub fn overlay_image(
    image_pixels: &mut Vec<u8>,
    image_width: usize,
    target_image: &image::DynamicImage,
    offset_x: usize,
    offset_y: usize,
    channel_count: usize,
) {
    overlay_image_ptr(
        image_pixels.as_mut_ptr(),
        image_width,
        target_image,
        offset_x,
        offset_y,
        channel_count,
    );
}

#[cfg(target_os = "windows")]
pub async fn write_bitmap_image_to_clipboard_core(
    rgba_image: &[u8],
    image_width: usize,
    image_height: usize,
) -> Result<(), String> {
    // 如果是 Windows 系统则尝试使用 DIB 格式写入到剪贴板
    // Windows 下使用 DIB 格式写入到剪贴板，比 BMP 文件格式更标准
    #[cfg(target_os = "windows")]
    {
        use clipboard_win::{Setter, formats, types::BITMAPINFOHEADER};
        use rayon::prelude::*;
        use std::mem;

        // 计算 DIB 数据大小：BITMAPINFOHEADER + 像素数据
        let header_size = mem::size_of::<BITMAPINFOHEADER>();
        let row_size = ((image_width * 3 + 3) / 4) * 4; // 4字节对齐
        let pixel_data_size = row_size * image_height;
        let total_size = header_size + pixel_data_size;

        let mut dib_data = Vec::with_capacity(total_size);
        unsafe {
            dib_data.set_len(total_size);
        }

        // 构建 BITMAPINFOHEADER
        let bmi_header = BITMAPINFOHEADER {
            biSize: header_size as u32,
            biWidth: image_width as i32,
            biHeight: image_height as i32, // 底部向上
            biPlanes: 1,
            biBitCount: 24,   // RGB
            biCompression: 0, // BI_RGB
            biSizeImage: pixel_data_size as u32,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };

        // 将 header 写入为字节
        let header_bytes = unsafe {
            std::slice::from_raw_parts(
                &bmi_header as *const BITMAPINFOHEADER as *const u8,
                header_size,
            )
        };
        let dib_data_ptr = dib_data.as_mut_ptr();
        unsafe {
            std::ptr::copy_nonoverlapping(header_bytes.as_ptr(), dib_data_ptr, header_bytes.len());
        }

        let dib_data_ptr = unsafe { dib_data_ptr.offset(header_bytes.len() as isize) } as usize;
        let rgba_image_ptr = rgba_image.as_ptr() as usize;
        (0..image_height).into_par_iter().rev().for_each(|y| {
            let rgba_index_start = y * image_width * 4;
            let dib_index_start = (image_height - y - 1) * row_size;
            (0..image_width).into_par_iter().for_each(|x| {
                let dib_data_ptr = dib_data_ptr as *mut u8;
                let rgba_image_ptr = rgba_image_ptr as *const u8;

                let rgba_base_index = rgba_index_start + x * 4;
                let dib_base_index = dib_index_start + x * 3;
                unsafe {
                    dib_data_ptr
                        .add(dib_base_index)
                        .write(rgba_image_ptr.add(rgba_base_index + 2).read());
                    dib_data_ptr
                        .add(dib_base_index + 1)
                        .write(rgba_image_ptr.add(rgba_base_index + 1).read());
                    dib_data_ptr
                        .add(dib_base_index + 2)
                        .write(rgba_image_ptr.add(rgba_base_index).read());
                }
            });
        });

        let _clip = clipboard_win::Clipboard::new().unwrap();

        formats::RawData(formats::CF_DIB)
            .write_clipboard(&dib_data)
            .map_err(|e| {
                format!(
                    "[write_bitmap_image_to_clipboard] Write CF_DIB to clipboard: {}",
                    e
                )
            })?;

        drop(_clip);

        Ok(())
    }
}

pub async fn write_bitmap_image_to_clipboard(
    #[allow(unused_variables)] image_data: &Vec<u8>,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err(String::from(
            "[write_bitmap_image_to_clipboard] Not supported on this platform",
        ));
    }

    // 如果是 Windows 系统则尝试使用 DIB 格式写入到剪贴板
    // Windows 下使用 DIB 格式写入到剪贴板，比 BMP 文件格式更标准
    #[cfg(target_os = "windows")]
    {
        use image::ImageDecoder;

        let decoder = match image::codecs::png::PngDecoder::new(std::io::Cursor::new(image_data)) {
            Ok(decoder) => decoder,
            Err(_) => {
                return Err(String::from(
                    "[write_bitmap_image_to_clipboard] Failed to create PNG decoder",
                ));
            }
        };
        let _ = decoder.dimensions();

        // 解码出的像素可能是 RGB8（如全屏截图生成的 Rgb8 PNG），但 DIB 写入函数
        // 始终按 RGBA（4 字节/像素）解析，直接透传会导致逐行错位花屏。
        // 因此统一转成 RGBA8 再交给 DIB 写入。
        let dynamic_image = match image::DynamicImage::from_decoder(
            image::codecs::png::PngDecoder::new(std::io::Cursor::new(image_data.clone())).unwrap(),
        ) {
            Ok(img) => img,
            Err(_) => {
                return Err(String::from(
                    "[write_bitmap_image_to_clipboard] Failed to decode PNG to dynamic image",
                ));
            }
        };
        let rgba_image = dynamic_image.to_rgba8();
        let (rgba_width, rgba_height) = rgba_image.dimensions();

        write_bitmap_image_to_clipboard_core(
            rgba_image.as_raw().as_ref(),
            rgba_width as usize,
            rgba_height as usize,
        )
        .await?;

        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub async fn write_bitmap_image_to_clipboard_with_shared_buffer(
    shared_buffer_service: tauri::State<'_, std::sync::Arc<snow_shot_webview::SharedBufferService>>,
    channel_id: String,
) -> Result<(), String> {
    let image_data = match shared_buffer_service.receive_data(channel_id) {
        Ok(image_data) => image_data,
        Err(e) => {
            return Err(format!(
                "[write_bitmap_image_to_clipboard_with_shared_buffer] Failed to receive image data: {}",
                e
            ));
        }
    };

    // 最后 8 个字节是 image_width 和 image_height
    let image_width = u32::from_le_bytes(
        image_data[image_data.len() - 8..image_data.len() - 4]
            .try_into()
            .unwrap(),
    );
    let image_height = u32::from_le_bytes(
        image_data[image_data.len() - 4..image_data.len()]
            .try_into()
            .unwrap(),
    );

    write_bitmap_image_to_clipboard_core(
        &image_data[..image_data.len() - 8],
        image_width as usize,
        image_height as usize,
    )
    .await?;

    Ok(())
}

pub fn get_request_header(
    request: &tauri::ipc::Request<'_>,
    header_name: &str,
) -> Result<HeaderValue, String> {
    let header = request.headers().get(header_name);
    match header {
        Some(header) => Ok(header.clone()),
        None => Err(String::from(format!(
            "[get_request_header] Missing header: {}",
            header_name
        ))),
    }
}

pub fn get_request_string_header(
    request: &tauri::ipc::Request<'_>,
    header_name: &str,
) -> Result<String, String> {
    let header = get_request_header(request, header_name)?;
    let base64_header = match header.to_str() {
        Ok(header) => header.to_string(),
        Err(_) => {
            return Err(format!(
                "[get_request_string_header] Invalid header: {}",
                header_name
            ));
        }
    };
    match BASE64_STANDARD.decode(base64_header) {
        Ok(header) => Ok(String::from_utf8(header).unwrap()),
        Err(_) => Err(format!(
            "[get_request_string_header] Invalid header: {}",
            header_name
        )),
    }
}

pub fn get_request_optional_string_header(
    request: &tauri::ipc::Request<'_>,
    header_name: &str,
) -> Result<Option<String>, String> {
    let text_header = match get_request_string_header(request, header_name) {
        Ok(text_header) => text_header,
        Err(_) => return Ok(None),
    };
    if text_header == "" {
        Ok(None)
    } else {
        Ok(Some(text_header))
    }
}

pub fn get_request_bool_header(
    request: &tauri::ipc::Request<'_>,
    header_name: &str,
) -> Result<bool, String> {
    let text_header = get_request_string_header(request, header_name)?;
    match text_header.parse::<bool>() {
        Ok(header) => Ok(header),
        Err(_) => {
            return Err(format!(
                "[get_request_bool_header] Invalid header: {}",
                header_name
            ));
        }
    }
}

pub async fn set_exclude_from_capture(
    #[allow(unused_variables)] window: &tauri::Window,
    #[allow(unused_variables)] enable: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let window_hwnd = window.hwnd();
        let window_hwnd = match window_hwnd {
            Ok(window_hwnd) => window_hwnd,
            Err(_) => {
                return Err(String::from(
                    "[set_exclude_from_capture] Failed to get HWND",
                ));
            }
        };

        // tauri 的 window.hwnd() 返回 wry 体系（windows 0.61）的 HWND，
        // 而本 crate 的 windows API 是 0.62；用原始指针重建为 0.62 的 HWND。
        let window_hwnd = windows::Win32::Foundation::HWND(window_hwnd.0);

        let result = unsafe {
            windows::Win32::UI::WindowsAndMessaging::SetWindowDisplayAffinity(
                window_hwnd,
                if enable {
                    windows::Win32::UI::WindowsAndMessaging::WDA_EXCLUDEFROMCAPTURE
                } else {
                    windows::Win32::UI::WindowsAndMessaging::WDA_NONE
                },
            )
        };

        if result.is_err() {
            return Err(format!(
                "[set_exclude_from_capture] Failed to set window display affinity: {}",
                result.err().unwrap()
            ));
        }

        Ok(())
    }
}
