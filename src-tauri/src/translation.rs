use tauri::command;

#[command]
pub async fn translate_text(request: tauri::ipc::Request<'_>) -> Result<Vec<String>, String> {
    snow_shot_tauri_commands_http_service::online::translate_text(request).await
}
