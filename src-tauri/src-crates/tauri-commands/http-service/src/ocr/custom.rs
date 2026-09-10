use std::io::Cursor;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Deserialize;

use super::build_http_client;
use super::normalize_error_code;
use super::ocr_line_to_text_block;
use super::OnlineOcrConfig;
use snow_shot_app_services::ocr_service::OcrDetectResult;

#[derive(Deserialize)]
struct CustomOcrResponse {
    #[serde(rename = "errorCode", default)]
    error_code: Option<serde_json::Value>,
    #[serde(default)]
    lines: Vec<super::OcrLine>,
}

pub(super) async fn detect_with_custom(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<OcrDetectResult, String> {
    let api_uri = config.api_uri.trim();
    if api_uri.is_empty() {
        return Err("[ocr_detect_online] Custom API address is empty".to_string());
    }
    if !api_uri.starts_with("http://") && !api_uri.starts_with("https://") {
        return Err(
            "[ocr_detect_online] Custom API address must start with http:// or https://"
                .to_string(),
        );
    }

    let mut png_bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("[ocr_detect_online] Failed to encode image: {}", e))?;
    let data_url = format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(&png_bytes)
    );

    let client = build_http_client()?;
    let response = client
        .post(api_uri)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "q": data_url }).to_string())
        .send()
        .await
        .map_err(|e| format!("[ocr_detect_online] Custom request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("[ocr_detect_online] Custom read response failed: {}", e))?;

    let ocr_response: CustomOcrResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Custom parse response failed: {}, status: {}, body: {}",
            e, status, body
        )
    })?;

    let error_code = normalize_error_code(&ocr_response.error_code);
    if !error_code.is_empty() && error_code != "0" {
        return Err(format!("[ocr_detect_online] Custom error {}", error_code));
    }

    let mut text_blocks = Vec::new();
    for line in &ocr_response.lines {
        if let Some(block) = ocr_line_to_text_block(line) {
            text_blocks.push(block);
        }
    }

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}
