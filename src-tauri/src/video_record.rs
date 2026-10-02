use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use tauri::command;

use snow_shot_app_services::video_record_capture::{RecordPixelFormat, VideoCaptureBackend};
use snow_shot_app_services::video_record_service::VideoFormat;
use snow_shot_app_services::video_record_service::VideoRecordService;

#[command]
pub async fn video_record_init(
    video_service: tauri::State<'_, Arc<Mutex<VideoRecordService>>>,
    ffmpeg_plugin_dir: PathBuf,
) -> Result<(), String> {
    let mut service = video_service.lock().await;
    service.init(&ffmpeg_plugin_dir);
    Ok(())
}

/// 在用户点"开始录制"之前预热编码器（选区界面出现时调用）。
///
/// 一次性的临时 ffmpeg 进程：把 ffmpeg 依赖读进系统缓存，并让硬件编码器提前
/// 度过启动期（那段时间会冻结桌面合成，提前发生就不会被录进画面）。
#[command]
pub async fn video_record_warmup(
    video_service: tauri::State<'_, Arc<Mutex<VideoRecordService>>>,
    encoder: String,
    encoder_preset: String,
    width: i32,
    height: i32,
    frame_rate: u32,
) -> Result<(), String> {
    let service = video_service.lock().await;
    service.warmup_encoder(&encoder, &encoder_preset, width, height, frame_rate);
    Ok(())
}

/// 开始视频录制
#[command]
pub async fn video_record_start(
    video_service: tauri::State<'_, Arc<Mutex<VideoRecordService>>>,
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
    output_file: String,
    format: VideoFormat,
    frame_rate: u32,
    enable_microphone: bool,
    enable_system_audio: bool,
    microphone_device_name: String,
    hwaccel: bool,
    encoder: String,
    encoder_preset: String,
    video_max_width: i32,
    video_max_height: i32,
    // 视频采集后端（缺省 pinray；旧前端调用自动兼容）
    capture_backend: Option<VideoCaptureBackend>,
    // 采集像素格式（仅 pinray 后端生效，缺省 bgra）
    pixel_format: Option<RecordPixelFormat>,
    // 是否把鼠标指针合成进画面（缺省不录）
    capture_cursor: Option<bool>,
) -> Result<(), String> {
    println!(
        "Starting video recording: area=({},{}) to ({},{}), output={}",
        min_x, min_y, max_x, max_y, output_file
    );

    let mut service = video_service.lock().await;

    match service.start(
        min_x,
        min_y,
        max_x,
        max_y,
        output_file,
        format,
        frame_rate,
        enable_microphone,
        enable_system_audio,
        microphone_device_name,
        hwaccel,
        encoder,
        encoder_preset,
        video_max_width,
        video_max_height,
        capture_backend.unwrap_or_default(),
        pixel_format.unwrap_or_default(),
        capture_cursor.unwrap_or(false),
    ) {
        Ok(_) => {
            println!("Video recording started successfully");
            Ok(())
        }
        Err(e) => {
            println!("Video recording start failed: {}", e);
            Err(format!("Start recording failed: {}", e))
        }
    }
}

/// 停止视频录制
#[command]
pub async fn video_record_stop(
    video_service: tauri::State<'_, Arc<Mutex<VideoRecordService>>>,
    convert_to_gif: bool,
    gif_format: String,
    gif_frame_rate: u32,
    gif_max_width: i32,
    gif_max_height: i32,
) -> Result<Option<String>, String> {
    println!("Stopping video recording...");

    let mut service = video_service.lock().await;

    match service.stop(
        convert_to_gif,
        &gif_format,
        gif_frame_rate,
        gif_max_width,
        gif_max_height,
    ) {
        Ok(final_filename) => {
            println!("Video recording stopped successfully");
            Ok(final_filename)
        }
        Err(e) => {
            println!("Video recording stop failed: {}", e);
            Err(format!("Stop recording failed: {}", e))
        }
    }
}

/// 暂停视频录制
#[command]
pub async fn video_record_pause(
    video_service: tauri::State<'_, Arc<Mutex<VideoRecordService>>>,
) -> Result<(), String> {
    let mut service = video_service.lock().await;

    match service.pause() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Pause recording failed: {}", e)),
    }
}

/// 恢复视频录制
#[command]
pub async fn video_record_resume(
    video_service: tauri::State<'_, Arc<Mutex<VideoRecordService>>>,
) -> Result<(), String> {
    let mut service = video_service.lock().await;

    match service.resume() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Resume recording failed: {}", e)),
    }
}

#[command]
pub async fn video_record_get_microphone_device_names(
    video_service: tauri::State<'_, Arc<Mutex<VideoRecordService>>>,
) -> Result<Vec<String>, String> {
    let mut service = video_service.lock().await;
    Ok(service.get_microphone_device_names())
}

#[command]
pub async fn video_record_kill(
    video_service: tauri::State<'_, Arc<Mutex<VideoRecordService>>>,
) -> Result<(), String> {
    let mut service = video_service.lock().await;
    match service.kill() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Kill recording failed: {}", e)),
    }
}
