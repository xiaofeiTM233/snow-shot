use std::path::PathBuf;

use tauri::command;
use tokio::sync::Mutex;

use snow_shot_app_services::ocr_service::OcrService;
use snow_shot_tauri_commands_ocr::OcrDetectResult;

#[command]
pub async fn ocr_init(
    ocr_instance: tauri::State<'_, Mutex<OcrService>>,
    orc_plugin_path: PathBuf,
    det_model: Option<String>,
    cls_model: Option<String>,
    rec_model: Option<String>,
    hot_start: bool,
    model_write_to_memory: bool,
) -> Result<(), String> {
    snow_shot_tauri_commands_ocr::ocr_init(
        orc_plugin_path,
        ocr_instance,
        det_model,
        cls_model,
        rec_model,
        hot_start,
        model_write_to_memory,
    )
    .await
}

#[command]
pub async fn ocr_detect(
    ocr_instance: tauri::State<'_, Mutex<OcrService>>,
    request: tauri::ipc::Request<'_>,
) -> Result<OcrDetectResult, String> {
    snow_shot_tauri_commands_ocr::ocr_detect(ocr_instance, request).await
}

#[cfg(target_os = "windows")]
#[command]
pub async fn ocr_detect_with_shared_buffer(
    ocr_instance: tauri::State<'_, Mutex<OcrService>>,
    shared_buffer_service: tauri::State<'_, std::sync::Arc<snow_shot_webview::SharedBufferService>>,
    channel_id: String,
    scale_factor: f32,
    detect_angle: bool,
) -> Result<OcrDetectResult, String> {
    snow_shot_tauri_commands_ocr::ocr_detect_with_shared_buffer(
        ocr_instance,
        shared_buffer_service,
        channel_id,
        scale_factor,
        detect_angle,
    )
    .await
}

#[command]
pub async fn ocr_release(ocr_instance: tauri::State<'_, Mutex<OcrService>>) -> Result<(), String> {
    snow_shot_tauri_commands_ocr::ocr_release(ocr_instance).await
}

#[command]
pub async fn list_ocr_model_files(dir_path: PathBuf) -> Result<Vec<String>, String> {
    snow_shot_tauri_commands_ocr::list_ocr_model_files(dir_path).await
}

#[command]
pub async fn online_ocr_detect(
    request: tauri::ipc::Request<'_>,
) -> Result<snow_shot_tauri_commands_ocr::OnlineOcrDetectResult, String> {
    snow_shot_tauri_commands_ocr::online_ocr_detect(request).await
}
