use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Deserialize;

use super::{TranslateTextResult, TranslationConfig};
use crate::common::{build_http_client, hmac_sha256, utc_date_from_unix};
use crate::ocr::{prepare_image_bytes, OnlineOcrConfig};
use snow_shot_app_services::ocr_service::{OcrDetectResult, TextBlock};

const VOLC_MT_ENDPOINT: &str = "https://translate.volcengineapi.com";
const VOLC_MT_HOST: &str = "translate.volcengineapi.com";
const VOLC_MT_SERVICE: &str = "translate";
const VOLC_MT_REGION: &str = "cn-north-1";
const VOLC_TEXT_VERSION: &str = "2020-06-01";
const VOLC_IMAGE_VERSION: &str = "2020-07-01";
/// 文本翻译单次最多 16 条，总文本长度不超过 5000 字符
const VOLC_TEXT_MAX_ITEMS: usize = 16;
const VOLC_TEXT_MAX_TOTAL_CHARS: usize = 5000;
/// 图片翻译限制 4M
const VOLC_IMAGE_MAX_BASE64_LENGTH: usize = 5_000_000;
const VOLC_IMAGE_MAX_SIDE: u32 = 4096;

pub(super) async fn translate_text(
    config: &TranslationConfig,
    texts: Vec<String>,
    from: String,
    to: String,
) -> Result<TranslateTextResult, String> {
    // 凭据去除首尾空白，避免复制粘贴引入空格导致签名校验失败
    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err(
            "[translate_text_online] Volcengine AccessKeyId or SecretAccessKey is empty".to_string(),
        );
    }

    let region = if config.region.is_empty() {
        VOLC_MT_REGION
    } else {
        &config.region
    };
    let target = map_target_language(&to);

    // TextList 天然支持批量，按条数与总字符数分块
    let mut results: Vec<String> = vec![String::new(); texts.len()];
    for chunk in chunk_texts(&texts) {
        let mut body = serde_json::Map::new();
        // SourceLanguage 不传时自动检测
        let source = map_source_language(&from);
        if let Some(source) = source {
            body.insert(
                "SourceLanguage".to_string(),
                serde_json::Value::String(source),
            );
        }
        body.insert(
            "TargetLanguage".to_string(),
            serde_json::Value::String(target.clone()),
        );
        body.insert(
            "TextList".to_string(),
            serde_json::Value::Array(
                chunk
                    .iter()
                    .map(|(text, _)| serde_json::Value::String(text.to_string()))
                    .collect(),
            ),
        );

        let body = post_mt_api(
            secret_id,
            secret_key,
            region,
            "TranslateText",
            VOLC_TEXT_VERSION,
            serde_json::Value::Object(body).to_string(),
        )
        .await?;
        let response: VolcTextResponse = serde_json::from_str(&body).map_err(|e| {
            format!(
                "[translate_text_online] Volcengine parse response failed: {}, body: {}",
                e, body
            )
        })?;

        if let Some(error) = response.response_metadata.and_then(|metadata| metadata.error) {
            return Err(format!(
                "[translate_text_online] Volcengine error {}: {}",
                error.code, error.message
            ));
        }

        for ((_, original_index), translation) in chunk.iter().zip(&response.translation_list) {
            if let Some(slot) = results.get_mut(*original_index) {
                *slot = translation.translation.clone();
            }
        }
    }

    Ok(TranslateTextResult { results, from: None })
}

/// 将文本列表按单次请求的条数与总字符数限制分块，块内元素保留原始索引
fn chunk_texts(texts: &[String]) -> Vec<Vec<(&String, usize)>> {
    let mut chunks: Vec<Vec<(&String, usize)>> = Vec::new();
    let mut current: Vec<(&String, usize)> = Vec::new();
    let mut current_chars = 0usize;

    for (index, text) in texts.iter().enumerate() {
        let chars = text.chars().count();
        if !current.is_empty()
            && (current.len() >= VOLC_TEXT_MAX_ITEMS
                || current_chars + chars > VOLC_TEXT_MAX_TOTAL_CHARS)
        {
            chunks.push(std::mem::take(&mut current));
            current_chars = 0;
        }
        current_chars += chars;
        current.push((text, index));
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

/// 火山引擎文本翻译源语言：不配置时自动检测
fn map_source_language(lang: &str) -> Option<String> {
    match lang {
        "" | "auto" => None,
        "zh-CHS" => Some("zh".to_string()),
        "zh-CHT" => Some("zh-Hant".to_string()),
        other => Some(other.to_string()),
    }
}

/// 火山引擎目标语言：目标语言不支持 auto
fn map_target_language(lang: &str) -> String {
    match lang {
        "" | "auto" | "zh-CHS" => "zh".to_string(),
        "zh-CHT" => "zh-Hant".to_string(),
        other => other.to_string(),
    }
}

/// 火山引擎 V4 签名（与 OCR 模块一致，JSON 请求体）
async fn post_mt_api(
    secret_id: &str,
    secret_key: &str,
    region: &str,
    action: &str,
    version: &str,
    body: String,
) -> Result<String, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("[translate_text_online] Failed to get current time: {}", e))?;
    let timestamp = now.as_secs();
    let date = utc_date_from_unix(timestamp);
    let short_date = date.replace('-', "");
    let secs_of_day = timestamp % 86_400;
    let x_date = format!(
        "{}T{:02}{:02}{:02}Z",
        short_date,
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    );
    let body_hash = crate::common::sha256_hex(body.as_bytes());

    let query = format!("Action={}&Version={}", action, version);
    let signed_headers = "content-type;host;x-content-sha256;x-date";
    let canonical_headers = format!(
        "content-type:application/json\nhost:{}\nx-content-sha256:{}\nx-date:{}\n",
        VOLC_MT_HOST, body_hash, x_date
    );
    let canonical_request = format!(
        "POST\n/\n{}\n{}\n{}\n{}",
        query, canonical_headers, signed_headers, body_hash
    );
    let credential_scope = format!(
        "{}/{}/{}/request",
        short_date, region, VOLC_MT_SERVICE
    );
    let string_to_sign = format!(
        "HMAC-SHA256\n{}\n{}\n{}",
        x_date,
        credential_scope,
        crate::common::sha256_hex(canonical_request.as_bytes())
    );

    // 派生签名密钥：SecretAccessKey -> 日期 -> 地域 -> 服务 -> "request"
    let k_date = hmac_sha256(secret_key.as_bytes(), short_date.as_bytes())?;
    let k_region = hmac_sha256(&k_date, region.as_bytes())?;
    let k_service = hmac_sha256(&k_region, VOLC_MT_SERVICE.as_bytes())?;
    let k_signing = hmac_sha256(&k_service, b"request")?;
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes())?);

    let authorization = format!(
        "HMAC-Credential Credential={}/{}, SignedHeaders={}, Signature={}",
        secret_id, credential_scope, signed_headers, signature
    );

    let client = build_http_client()?;
    let response = client
        .post(VOLC_MT_ENDPOINT)
        .query(&[("Action", action), ("Version", version)])
        .header("Content-Type", "application/json")
        .header("X-Date", &x_date)
        .header("X-Content-Sha256", &body_hash)
        .header("Authorization", authorization)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("[translate_text_online] Volcengine request failed: {}", e))?;

    response
        .text()
        .await
        .map_err(|e| format!("[translate_text_online] Volcengine read response failed: {}", e))
}

#[derive(Deserialize)]
struct VolcTextResponse {
    #[serde(rename = "TranslationList", default)]
    translation_list: Vec<VolcTranslation>,
    #[serde(rename = "ResponseMetadata", default)]
    response_metadata: Option<VolcResponseMetadata>,
}

#[derive(Deserialize)]
struct VolcTranslation {
    #[serde(rename = "Translation", default)]
    translation: String,
    #[serde(rename = "DetectedSourceLanguage", default)]
    detected_source_language: Option<String>,
}

#[derive(Deserialize)]
struct VolcResponseMetadata {
    #[serde(rename = "Error", default)]
    error: Option<VolcError>,
}

#[derive(Deserialize)]
struct VolcError {
    #[serde(rename = "Code", default)]
    code: String,
    #[serde(rename = "Message", default)]
    message: String,
}

/// 火山引擎图片翻译响应（TranslateImage, Version=2020-07-01）
#[derive(Deserialize)]
struct VolcImageResponse {
    #[serde(rename = "TextBlocks", default)]
    text_blocks: Vec<VolcImageTextBlock>,
    #[serde(rename = "ResponseMetadata", default)]
    response_metadata: Option<VolcResponseMetadata>,
}

#[derive(Deserialize)]
struct VolcImageTextBlock {
    #[serde(rename = "Points", default)]
    points: Vec<VolcPoint>,
    #[serde(rename = "Translation", default)]
    translation: String,
}

#[derive(Deserialize)]
struct VolcPoint {
    #[serde(rename = "X", default)]
    x: i64,
    #[serde(rename = "Y", default)]
    y: i64,
}

/// 图片翻译（TranslateImage），结果按 OCR 接入商的方式返回
pub(crate) async fn translate_image_as_ocr(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<OcrDetectResult, String> {
    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err(
            "[ocr_detect_online] Volcengine AccessKeyId or SecretAccessKey is empty".to_string(),
        );
    }

    let region = if config.region.is_empty() {
        VOLC_MT_REGION
    } else {
        &config.region
    };

    let image_bytes = prepare_image_bytes(image, VOLC_IMAGE_MAX_SIDE, VOLC_IMAGE_MAX_BASE64_LENGTH)?;
    let image_base64 = BASE64_STANDARD.encode(&image_bytes);

    let target = if config.target_language.is_empty() {
        "zh".to_string()
    } else {
        map_target_language(&config.target_language)
    };

    let payload = serde_json::json!({
        "Image": image_base64,
        "TargetLanguage": target,
    })
    .to_string();

    let body = post_mt_api(
        secret_id,
        secret_key,
        region,
        "TranslateImage",
        VOLC_IMAGE_VERSION,
        payload,
    )
    .await?;
    let response: VolcImageResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Volcengine parse response failed: {}, body: {}",
            e, body
        )
    })?;

    if let Some(metadata) = &response.response_metadata {
        if let Some(error) = &metadata.error {
            return Err(format!(
                "[ocr_detect_online] Volcengine error {}: {}",
                error.code, error.message
            ));
        }
    }

    let text_blocks = response
        .text_blocks
        .iter()
        .filter(|block| !block.translation.is_empty() && block.points.len() >= 3)
        .map(|block| TextBlock {
            box_points: block
                .points
                .iter()
                .map(|point| snow_shot_app_services::ocr_service::Point {
                    x: point.x.max(0) as u32,
                    y: point.y.max(0) as u32,
                })
                .collect(),
            box_score: 1.0,
            angle_index: 0,
            angle_score: 0.0,
            text: block.translation.clone(),
            text_score: 1.0,
        })
        .collect();

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}
