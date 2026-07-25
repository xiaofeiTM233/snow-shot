use snow_shot_app_services::file_cache_service::FileCacheService;
use std::{path::PathBuf, sync::Arc};
use tauri::command;

#[command]
pub async fn save_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    snow_shot_tauri_commands_file::save_file(request).await
}

#[command]
pub async fn write_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    snow_shot_tauri_commands_file::write_file(request).await
}

#[command]
pub async fn remove_file(file_path: PathBuf) -> Result<(), String> {
    snow_shot_tauri_commands_file::remove_file(file_path).await
}

#[command]
pub async fn copy_file(from: PathBuf, to: PathBuf) -> Result<(), String> {
    snow_shot_tauri_commands_file::copy_file(from, to).await
}

#[command]
pub async fn text_file_read(
    text_file_cache_service: tauri::State<'_, Arc<FileCacheService>>,
    file_path: PathBuf,
) -> Result<String, String> {
    text_file_cache_service.read(file_path.clone())
}

#[command]
pub async fn text_file_write(
    text_file_cache_service: tauri::State<'_, Arc<FileCacheService>>,
    file_path: PathBuf,
    content: String,
) -> Result<(), String> {
    text_file_cache_service.write(file_path, content)
}

#[command]
pub async fn text_file_clear(
    text_file_cache_service: tauri::State<'_, Arc<FileCacheService>>,
) -> Result<(), String> {
    text_file_cache_service.clear();
    Ok(())
}

#[command]
pub async fn create_dir(
    text_file_cache_service: tauri::State<'_, Arc<FileCacheService>>,
    dir_path: PathBuf,
) -> Result<(), String> {
    text_file_cache_service.create_dir(dir_path)
}

#[command]
pub async fn create_local_config_dir(
    app: tauri::AppHandle,
    text_file_cache_service: tauri::State<'_, Arc<FileCacheService>>,
    path: PathBuf,
) -> Result<(), String> {
    text_file_cache_service.create_custom_config_dir(&app, path)
}

#[command]
pub async fn remove_dir(dir_path: PathBuf) -> Result<(), String> {
    tokio::fs::remove_dir_all(dir_path)
        .await
        .map_err(|e| format!("[remove_dir] Failed to remove directory: {}", e.to_string()))?;

    Ok(())
}

#[command]
pub async fn get_app_config_dir(
    app: tauri::AppHandle,
    text_file_cache_service: tauri::State<'_, Arc<FileCacheService>>,
) -> Result<PathBuf, String> {
    let path = text_file_cache_service.get_app_config_dir(&app)?;
    Ok(path)
}

#[command]
pub async fn get_app_config_base_dir(
    app: tauri::AppHandle,
    text_file_cache_service: tauri::State<'_, Arc<FileCacheService>>,
) -> Result<PathBuf, String> {
    let path = text_file_cache_service.get_app_config_base_dir(&app)?;
    Ok(path)
}

#[command]
pub async fn get_app_cache_dir(
    app: tauri::AppHandle,
    text_file_cache_service: tauri::State<'_, Arc<FileCacheService>>,
) -> Result<PathBuf, String> {
    let path = text_file_cache_service.get_app_cache_dir(&app)?;
    Ok(path)
}

#[command]
pub async fn create_local_cache_dir(
    app: tauri::AppHandle,
    text_file_cache_service: tauri::State<'_, Arc<FileCacheService>>,
    path: PathBuf,
) -> Result<(), String> {
    text_file_cache_service.create_local_cache_dir(&app, path)
}

#[command]
pub async fn is_portable_app(
    text_file_cache_service: tauri::State<'_, Arc<FileCacheService>>,
) -> Result<bool, String> {
    Ok(text_file_cache_service.is_portable_app())
}
