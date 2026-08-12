use image::codecs::png::{self, CompressionType, PngEncoder};
use image::imageops::FilterType;
use serde::Serialize;
use snow_shot_app_scroll_screenshot_service::scroll_screenshot_capture_service::ScrollScreenshotCaptureService;
use snow_shot_app_shared::ElementRect;
use snow_shot_app_utils::monitor_info::{
	CaptureMethod, CaptureOption, ColorFormat, CorrectHdrColorAlgorithm,
};
use snow_shot_global_state::WebViewSharedBufferState;
use std::path::PathBuf;
use tauri::ipc::Response;
use tokio::sync::Mutex;

use snow_shot_app_scroll_screenshot_service::scroll_screenshot_image_service::ScrollScreenshotImageService;
use snow_shot_app_scroll_screenshot_service::scroll_screenshot_service::{
    ScrollDirection, ScrollImageList, ScrollScreenshotService,
};
use snow_shot_app_utils::{self, save_image_to_file};

pub async fn scroll_screenshot_init(
    scroll_screenshot_service: tauri::State<'_, Mutex<ScrollScreenshotService>>,
    direction: ScrollDirection,
    sample_rate: f32,
    min_sample_size: u32,
    max_sample_size: u32,
    corner_threshold: u8,
    descriptor_patch_size: usize,
    min_size_delta: i32,
    try_rollback: bool,
) -> Result<(), String> {
    let mut scroll_screenshot_service = scroll_screenshot_service.lock().await;

    scroll_screenshot_service.init(
        direction,
        sample_rate,
        min_sample_size,
        max_sample_size,
        corner_threshold,
        descriptor_patch_size,
        min_size_delta,
        try_rollback,
    );

    Ok(())
}

pub async fn scroll_screenshot_capture(
    window: tauri::Window,
    scroll_screenshot_image_service: tauri::State<'_, Mutex<ScrollScreenshotImageService>>,
    scroll_screenshot_capture_service: tauri::State<'_, Mutex<ScrollScreenshotCaptureService>>,
    scroll_image_list: ScrollImageList,
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
    correct_hdr_color_algorithm: CorrectHdrColorAlgorithm,
    correct_color_filter: bool,
    capture_method: CaptureMethod,
) -> Result<(), String> {
    // 区域截图
    let image = {
        #[cfg(target_os = "macos")]
        let rect_scale;
        #[cfg(not(target_os = "macos"))]
        let rect_scale = 1.0f64;

        // macOS 下截图区域是基于逻辑像素
        #[cfg(target_os = "macos")]
        {
            rect_scale = (1.0 / window.scale_factor().unwrap_or(1.0)) as f64;
        }

        let min_x = min_x as f64 * rect_scale;
        let min_y = min_y as f64 * rect_scale;
        let max_x = max_x as f64 * rect_scale;
        let max_y = max_y as f64 * rect_scale;

        let crop_region = ElementRect {
            min_x: min_x.round() as i32,
            min_y: min_y.round() as i32,
            max_x: max_x.round() as i32,
            max_y: max_y.round() as i32,
        };
        let monitor_list = {
            let mut monitor_list_service = scroll_screenshot_capture_service.lock().await;
            monitor_list_service.init(
                crop_region,
                correct_hdr_color_algorithm == CorrectHdrColorAlgorithm::None,
            );
            monitor_list_service.get()
        };

        monitor_list
            .capture_region(
                crop_region,
                Some(&window),
                CaptureOption {
                    color_format: ColorFormat::Rgba8,
                    correct_hdr_color_algorithm,
                    correct_color_filter,
                    capture_method,
                },
            )
            .await?
    };

    scroll_screenshot_image_service
        .lock()
        .await
        .push_image(image, scroll_image_list);

    Ok(())
}

/**
 * 处理目前截取到的所有图片
 */
pub async fn scroll_screenshot_handle_image(
    scroll_screenshot_service: tauri::State<'_, Mutex<ScrollScreenshotService>>,
    scroll_screenshot_image_service: tauri::State<'_, Mutex<ScrollScreenshotImageService>>,
    thumbnail_size: u32,
) -> Result<Response, ()> {
    let mut scroll_screenshot_service = scroll_screenshot_service.lock().await;

    // 把 scroll_screenshot_image_service.lock 后置，降低阻塞截图的概率，让截图堆积在截图队列中
    let has_left_image;
    let scroll_image = {
        let mut scroll_screenshot_image_service = scroll_screenshot_image_service.lock().await;

        // 下面 pop 了，所以需要大于 1
        has_left_image = scroll_screenshot_image_service.image_count() > 1;

        match scroll_screenshot_image_service.pop_image() {
            Some(scroll_image) => scroll_image,
            None => return Ok(Response::new(vec![2])), // 特殊标记，表示没有图片
        }
    };

    let (handle_result, is_origin, result_scroll_image_list) =
        scroll_screenshot_service.handle_image(scroll_image.image, scroll_image.direction);

    if is_origin {
        return Ok(Response::new(vec![1])); // 特殊标记，表示是未变化
    }

    let handle_result = match handle_result {
        Some(result) => result,
        None => {
            return if has_left_image {
                Ok(Response::new(vec![1])) // 还有剩余图片，这里就返回未变化，不提示用户未识别到
            } else {
                Ok(Response::new(Vec::new()))
            };
        }
    };

    let crop_image = match handle_result {
        (edge_position, None) => {
            return Ok(Response::new(edge_position.to_le_bytes().to_vec()));
        }
        (_, Some(ScrollImageList::Top)) => scroll_screenshot_service.top_image_list.last().unwrap(),
        (_, Some(ScrollImageList::Bottom)) => {
            scroll_screenshot_service.bottom_image_list.last().unwrap()
        }
    };

    let mut buf = Vec::new();

    let image_width = crop_image.image.width();
    let image_height = crop_image.image.height();
    let scale = if scroll_screenshot_service.current_direction == ScrollDirection::Vertical {
        thumbnail_size as f32 / image_width as f32
    } else {
        thumbnail_size as f32 / image_height as f32
    };

    let thumbnail = crop_image.image.resize(
        ((image_width as f32 * scale) as u32).max(1), // 防止图片某一边为 0
        ((image_height as f32 * scale) as u32).max(1),
        FilterType::Triangle,
    );

    thumbnail
        .write_with_encoder(PngEncoder::new_with_quality(
            &mut buf,
            CompressionType::Fast,
            png::FilterType::Paeth,
        ))
        .unwrap();

    // 添加边缘位置信息到缓冲区末尾
    buf.extend_from_slice(&handle_result.0.to_le_bytes());
    buf.extend_from_slice(&((crop_image.overlay_size as f32 * scale) as i32).to_le_bytes());
    buf.extend_from_slice(&scroll_screenshot_service.top_image_size.to_le_bytes());
    buf.extend_from_slice(&scroll_screenshot_service.bottom_image_size.to_le_bytes());
    buf.extend_from_slice(&(result_scroll_image_list as i32).to_le_bytes());

    Ok(Response::new(buf))
}

#[derive(Serialize)]
pub struct ScrollScreenshotCaptureSize {
    pub top_image_size: i32,
    pub bottom_image_size: i32,
}

pub async fn scroll_screenshot_get_size(
    scroll_screenshot_service: tauri::State<'_, Mutex<ScrollScreenshotService>>,
) -> Result<ScrollScreenshotCaptureSize, ()> {
    let scroll_screenshot_service = scroll_screenshot_service.lock().await;

    Ok(ScrollScreenshotCaptureSize {
        top_image_size: scroll_screenshot_service.top_image_size,
        bottom_image_size: scroll_screenshot_service.bottom_image_size,
    })
}

pub async fn scroll_screenshot_save_to_file(
    scroll_screenshot_service: tauri::State<'_, Mutex<ScrollScreenshotService>>,
    file_path: String,
) -> Result<(), String> {
    let mut scroll_screenshot_service = scroll_screenshot_service.lock().await;

    let image = scroll_screenshot_service.export();
    let image = match image {
        Some(image) => image,
        None => {
            return Err(format!(
                "[scroll_screenshot_save_to_file] Failed to export image"
            ));
        }
    };

    save_image_to_file(&image, PathBuf::from(file_path)).await?;

    Ok(())
}

pub async fn scroll_screenshot_save_to_clipboard<F>(
    write_image_to_clipboard: F,
    scroll_screenshot_service: tauri::State<'_, Mutex<ScrollScreenshotService>>,
) -> Result<(), String>
where
    F: Fn(&image::DynamicImage) -> Result<(), String>,
{
    let mut scroll_screenshot_service = scroll_screenshot_service.lock().await;

    let image = scroll_screenshot_service.export();
    match image {
        Some(image) => match write_image_to_clipboard(&image) {
            Ok(_) => (),
            Err(e) => {
                return Err(e);
            }
        },
        None => {
            return Err(String::from(
                "[scroll_screenshot_save_to_clipboard] Failed to export image",
            ));
        }
    }

    Ok(())
}

pub async fn scroll_screenshot_clear(
    scroll_screenshot_service: tauri::State<'_, Mutex<ScrollScreenshotService>>,
    scroll_screenshot_image_service: tauri::State<'_, Mutex<ScrollScreenshotImageService>>,
    scroll_screenshot_capture_service: tauri::State<'_, Mutex<ScrollScreenshotCaptureService>>,
) -> Result<(), String> {
    let mut scroll_screenshot_service = scroll_screenshot_service.lock().await;
    let mut scroll_screenshot_image_service = scroll_screenshot_image_service.lock().await;
    let mut scroll_screenshot_capture_service = scroll_screenshot_capture_service.lock().await;

    scroll_screenshot_service.clear();
    scroll_screenshot_image_service.clear();
    scroll_screenshot_capture_service.clear();

    Ok(())
}

pub async fn scroll_screenshot_get_image_data(
    scroll_screenshot_service: tauri::State<'_, Mutex<ScrollScreenshotService>>,
    #[allow(unused_variables)] webview_shared_buffer_state: tauri::State<
        '_,
        WebViewSharedBufferState,
    >,
    #[allow(unused_variables)] webview: tauri::Webview,
    force_to_png: bool,
) -> Result<Response, String> {
    let mut scroll_screenshot_service = scroll_screenshot_service.lock().await;

    let image = scroll_screenshot_service.export();
    let image_data = match image {
        Some(image) => image,
        None => {
            return Err(format!(
                "[scroll_screenshot_get_image_data] Failed to export image",
            ));
        }
    };

    #[cfg(target_os = "windows")]
    {
        // 判断是否支持通过 SharedBuffer 传递
        if !force_to_png && *webview_shared_buffer_state.enable.read().await {
            let mut extra_data = vec![0; 8];
            unsafe {
                let image_width = image_data.width();
                let image_height = image_data.height();
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
                image_data.as_bytes(),
                &extra_data,
                "scroll_screenshot".to_string(),
            )
            .await?;

            return Ok(Response::new(vec![1])); // 特殊标记，表示支持通过 SharedBuffer 传递
        }
    }

    let mut buf = Vec::new();

    match image_data.write_with_encoder(PngEncoder::new_with_quality(
        &mut buf,
        if force_to_png {
            CompressionType::Default
        } else {
            CompressionType::Fast
        },
        png::FilterType::Paeth,
    )) {
        Ok(_) => (),
        Err(e) => {
            return Err(format!(
                "[scroll_screenshot_get_image_data] Failed to write image: {}",
                e
            ));
        }
    }

    Ok(Response::new(buf))
}
