//! 腾讯云翻译适配器：文本翻译（TextTranslate）+ 图片翻译（ImageTranslateLLM）

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::Deserialize;

use super::MachineTranslatedImageLine;
use super::OnlineTranslationConfig;
use super::clamp_to_u32;
use super::tencent::{
    TENCENT_DEFAULT_REGION, TencentTmtError, TencentTmtResponse, map_tencent_language,
    tencent_tmt_request,
};

/// 腾讯云文本翻译限频 5 次/秒
const TENCENT_REQUEST_INTERVAL_MS: u64 = 220;
/// 单条文本长度需低于 6000 字符
const TENCENT_TEXT_MAX_CHARS: usize = 6000;
/// 图片 Base64 编码后最大 9M
const TENCENT_IMAGE_MAX_BASE64_LENGTH: usize = 9_000_000;

/// 腾讯云文本翻译：接口限频 5 次/秒，逐条请求
pub(super) async fn translate_text(
    config: &OnlineTranslationConfig,
    texts: Vec<String>,
) -> Result<Vec<String>, String> {
    let context = "[translate_text_tencent]";
    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err(format!(
            "{} Tencent SecretId or SecretKey is empty",
            context
        ));
    }
    if config.from == "auto" {
        return Err(format!(
            "{} Tencent text translation does not support auto source language",
            context
        ));
    }

    let region = if config.region.trim().is_empty() {
        TENCENT_DEFAULT_REGION.to_string()
    } else {
        config.region.trim().to_string()
    };
    let source = map_tencent_language(&config.from);
    let target = map_tencent_language(&config.to);

    let mut results: Vec<String> = Vec::new();
    for (index, text) in texts.iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(
                TENCENT_REQUEST_INTERVAL_MS,
            ))
            .await;
        }

        // 单条文本长度需低于 6000 字符，超长时按上限拆分后拼接译文
        let mut chunks: Vec<String> = Vec::new();
        let mut chunk = String::new();
        let mut chunk_chars = 0usize;
        for ch in text.chars() {
            chunk.push(ch);
            chunk_chars += 1;
            if chunk_chars == TENCENT_TEXT_MAX_CHARS {
                chunks.push(std::mem::take(&mut chunk));
                chunk_chars = 0;
            }
        }
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
        if chunks.is_empty() {
            results.push(String::new());
            continue;
        }

        let mut translated_text = String::new();
        for chunk in chunks {
            let payload = serde_json::json!({
                "SourceText": chunk,
                "Source": source,
                "Target": target,
                "ProjectId": 0,
            })
            .to_string();

            let body = tencent_tmt_request(
                context,
                "TextTranslate",
                payload,
                secret_id,
                secret_key,
                &region,
            )
            .await?;

            #[derive(Deserialize)]
            struct TextTranslateData {
                #[serde(rename = "TargetText", default)]
                target_text: Option<String>,
                #[serde(rename = "Error", default)]
                error: Option<TencentTmtError>,
            }

            let translate_response: TencentTmtResponse<TextTranslateData> =
                serde_json::from_str(&body).map_err(|e| {
                    format!("{} Tencent parse response failed: {}, body: {}", context, e, body)
                })?;
            let response_data = translate_response
                .response
                .ok_or(format!("{} Tencent empty response", context))?;
            if let Some(error) = &response_data.error {
                return Err(format!(
                    "{} Tencent error {}: {}",
                    context, error.code, error.message
                ));
            }

            translated_text.push_str(response_data.target_text.as_deref().unwrap_or(""));
        }

        results.push(translated_text);
    }

    Ok(results)
}

/// 腾讯云图片翻译（端到端图片翻译大模型）：自动识别源语言，返回逐行原文、译文与文本框
pub(super) async fn translate_image(
    config: &OnlineTranslationConfig,
    image_data: &[u8],
) -> Result<Vec<MachineTranslatedImageLine>, String> {
    let context = "[translate_image_tencent]";

    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err(format!(
            "{} Tencent SecretId or SecretKey is empty",
            context
        ));
    }

    let img_base64 = BASE64_STANDARD.encode(image_data);
    if img_base64.len() > TENCENT_IMAGE_MAX_BASE64_LENGTH {
        return Err(format!("{} Image too large (base64 > 9M)", context));
    }

    let region = if config.region.trim().is_empty() {
        TENCENT_DEFAULT_REGION.to_string()
    } else {
        config.region.trim().to_string()
    };
    let target = if config.to.is_empty() {
        "zh".to_string()
    } else {
        map_tencent_language(&config.to)
    };

    let payload = serde_json::json!({
        "Data": img_base64,
        "Target": target,
    })
    .to_string();

    let body = tencent_tmt_request(
        context,
        "ImageTranslateLLM",
        payload,
        secret_id,
        secret_key,
        &region,
    )
    .await?;

    #[derive(Deserialize)]
    struct ImageTranslateData {
        #[serde(rename = "TransDetails", default)]
        trans_details: Vec<ImageTranslateDetail>,
        #[serde(rename = "Error", default)]
        error: Option<TencentTmtError>,
    }
    #[derive(Deserialize)]
    struct ImageTranslateDetail {
        #[serde(rename = "SourceLineText", default)]
        source_line_text: String,
        #[serde(rename = "TargetLineText", default)]
        target_line_text: String,
        #[serde(rename = "BoundingBox", default)]
        bounding_box: Option<ImageTranslateBoundingBox>,
    }
    #[derive(Deserialize)]
    struct ImageTranslateBoundingBox {
        #[serde(rename = "X", default)]
        x: i64,
        #[serde(rename = "Y", default)]
        y: i64,
        #[serde(rename = "Width", default)]
        width: i64,
        #[serde(rename = "Height", default)]
        height: i64,
    }

    let translate_response: TencentTmtResponse<ImageTranslateData> =
        serde_json::from_str(&body).map_err(|e| {
            format!("{} Tencent parse response failed: {}, body: {}", context, e, body)
        })?;
    let response_data = translate_response
        .response
        .ok_or(format!("{} Tencent empty response", context))?;
    if let Some(error) = &response_data.error {
        return Err(format!(
            "{} Tencent error {}: {}",
            context, error.code, error.message
        ));
    }

    let mut lines = Vec::new();
    for detail in response_data.trans_details {
        if detail.target_line_text.is_empty() {
            continue;
        }

        let bounding_box = detail.bounding_box;
        lines.push(MachineTranslatedImageLine {
            source_text: detail.source_line_text,
            translated_text: detail.target_line_text,
            box_x: clamp_to_u32(bounding_box.as_ref().map(|box_| box_.x as f64).unwrap_or(0.0)),
            box_y: clamp_to_u32(bounding_box.as_ref().map(|box_| box_.y as f64).unwrap_or(0.0)),
            box_width: clamp_to_u32(
                bounding_box
                    .as_ref()
                    .map(|box_| box_.width as f64)
                    .unwrap_or(0.0),
            ),
            box_height: clamp_to_u32(
                bounding_box
                    .as_ref()
                    .map(|box_| box_.height as f64)
                    .unwrap_or(0.0),
            ),
        });
    }

    Ok(lines)
}
