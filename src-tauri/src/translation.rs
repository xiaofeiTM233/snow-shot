use snow_shot_tauri_commands_http_service::translation::{TranslateTextResult, TranslationConfig};
use tauri::command;

#[command]
pub async fn translate_text_online(
    config: TranslationConfig,
    texts: Vec<String>,
    from: String,
    to: String,
    domain: Option<String>,
) -> Result<TranslateTextResult, String> {
    snow_shot_tauri_commands_http_service::translation::translate_text(
        config,
        texts,
        from,
        to,
        domain.unwrap_or_else(|| "general".to_string()),
    )
    .await
}
