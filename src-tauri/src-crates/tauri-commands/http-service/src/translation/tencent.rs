use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use paddle_ocr_rs::ocr_result::TextBlock;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{TranslateTextResult, TranslationConfig};
use crate::common::{build_http_client, hmac_sha256, utc_date_from_unix};
use crate::ocr::rect_to_box_points;
use crate::ocr::{prepare_image_bytes, OnlineOcrConfig};
use snow_shot_app_services::ocr_service::OcrDetectResult;

const TENCENT_TMT_ENDPOINT: &str = "https://tmt.tencentcloudapi.com";
const TENCENT_TMT_HOST: &str = "tmt.tencentcloudapi.com";
const TENCENT_TMT_SERVICE: &str = "tmt";
const TENCENT_TMT_VERSION: &str = "2018-03-21";
const TENCENT_TMT_DEFAULT_REGION: &str = "ap-guangzhou";
/// TextTranslate 频率限制为 5 次/秒，多段文本时逐段限速
const TENCENT_TEXT_REQUEST_INTERVAL: std::time::Duration = std::time::Duration::from_millis(220);
/// 图片翻译限制 Base64 编码后不超过 9M
const TENCENT_IMAGE_MAX_BASE64_LENGTH: usize = 9_500_000;

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
        return Err("[translate_text_online] Tencent SecretId or SecretKey is empty".to_string());
    }

    let region = if config.region.is_empty() {
        TENCENT_TMT_DEFAULT_REGION
    } else {
        &config.region
    };

    let source = map_language_code(&from, true);
    let target = map_language_code(&to, false);

    let mut results = Vec::with_capacity(texts.len());
    let mut detected_from: Option<String> = None;
    for (index, text) in texts.iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(TENCENT_TEXT_REQUEST_INTERVAL).await;
        }

        let payload = serde_json::json!({
            "SourceText": text,
            "Source": source,
            "Target": target,
            "ProjectId": 0,
        })
        .to_string();

        let body = post_tmt_api(secret_id, secret_key, region, "TextTranslate", payload).await?;
        let data: TencentTextTranslateResponse = serde_json::from_str(&body).map_err(|e| {
            format!(
                "[translate_text_online] Tencent parse response failed: {}, body: {}",
                e, body
            )
        })?;

        if let Some(error) = &data.error {
            return Err(format!(
                "[translate_text_online] Tencent error {}: {}",
                error.code, error.message
            ));
        }

        if detected_from.is_none() && !data.source.is_empty() {
            detected_from = Some(data.source.clone());
        }

        results.push(data.target_text);
    }

    Ok(TranslateTextResult {
        results,
        from: detected_from,
    })
}

/// 将应用语言代码映射为腾讯云文本翻译的语言代码
fn map_language_code(lang: &str, allow_auto: bool) -> String {
    match lang {
        "zh-CHS" => "zh".to_string(),
        "zh-CHT" => "zh-TW".to_string(),
        "" | "auto" if allow_auto => "auto".to_string(),
        "" | "auto" => "zh".to_string(),
        other => other.to_string(),
    }
}

/// 将应用语言代码映射为腾讯云端到端图片翻译的目标语言代码
fn map_image_target_language(lang: &str) -> String {
    match lang {
        "zh-CHS" | "" | "auto" => "zh".to_string(),
        "zh-CHT" => "zh-TW".to_string(),
        "tr" => "tr-".to_string(),
        other => other.to_string(),
    }
}

async fn post_tmt_api(
    secret_id: &str,
    secret_key: &str,
    region: &str,
    action: &str,
    payload: String,
) -> Result<String, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("[translate_text_online] Failed to get current time: {}", e))?;
    let timestamp = now.as_secs();
    let date = utc_date_from_unix(timestamp);

    // TC3-HMAC-SHA256 签名
    let hashed_payload = hex::encode(Sha256::digest(payload.as_bytes()));
    // CanonicalHeaders 每行以 \n 结尾，与 SignedHeaders 之间还需再分隔一个空行
    let canonical_request = format!(
        "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{}\nx-tc-action:{}\n\ncontent-type;host;x-tc-action\n{}",
        TENCENT_TMT_HOST,
        action.to_lowercase(),
        hashed_payload
    );
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{}\n{}/{}/tc3_request\n{}",
        timestamp,
        date,
        TENCENT_TMT_SERVICE,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );

    // 派生签名密钥：TC3+SecretKey -> 日期 -> 服务名 -> "tc3_request"
    let secret_date = hmac_sha256(format!("TC3{}", secret_key).as_bytes(), date.as_bytes())?;
    let secret_service = hmac_sha256(&secret_date, TENCENT_TMT_SERVICE.as_bytes())?;
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request")?;
    let signature = hex::encode(hmac_sha256(&secret_signing, string_to_sign.as_bytes())?);

    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={}/{}/{}/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature={}",
        secret_id, date, TENCENT_TMT_SERVICE, signature
    );

    let client = build_http_client()?;
    let response = client
        .post(TENCENT_TMT_ENDPOINT)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("X-TC-Action", action)
        .header("X-TC-Version", TENCENT_TMT_VERSION)
        .header("X-TC-Timestamp", timestamp.to_string())
        .header("X-TC-Region", region)
        .header("Authorization", authorization)
        .body(payload)
        .send()
        .await
        .map_err(|e| format!("[translate_text_online] Tencent request failed: {}", e))?;

    response.text().await.map_err(|e| {
        format!(
            "[translate_text_online] Tencent read response failed: {}",
            e
        )
    })
}

#[derive(Deserialize)]
struct TencentTmtError {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct TencentTextTranslateResponse {
    #[serde(default)]
    error: Option<TencentTmtError>,
    #[serde(rename = "TargetText", default)]
    target_text: String,
    #[serde(rename = "Source", default)]
    source: String,
}

#[derive(Deserialize)]
struct TencentImageTranslateResponse {
    #[serde(default)]
    error: Option<TencentTmtError>,
    #[serde(rename = "TransDetails", default)]
    trans_details: Vec<TencentTransDetail>,
}

#[derive(Deserialize)]
struct TencentTransDetail {
    #[serde(rename = "BoundingBox")]
    bounding_box: Option<TencentBoundingBox>,
    #[serde(rename = "TargetLineText", default)]
    target_line_text: String,
}

#[derive(Deserialize)]
struct TencentBoundingBox {
    #[serde(rename = "X", default)]
    x: i64,
    #[serde(rename = "Y", default)]
    y: i64,
    #[serde(rename = "Width", default)]
    width: i64,
    #[serde(rename = "Height", default)]
    height: i64,
}

/// 端到端图片翻译（ImageTranslateLLM），结果按 OCR 接入商的方式返回
pub(crate) async fn translate_image_as_ocr(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<OcrDetectResult, String> {
    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err("[ocr_detect_online] Tencent SecretId or SecretKey is empty".to_string());
    }

    let region = if config.region.is_empty() {
        TENCENT_TMT_DEFAULT_REGION
    } else {
        &config.region
    };

    let image_bytes = prepare_image_bytes(image, u32::MAX, TENCENT_IMAGE_MAX_BASE64_LENGTH)?;
    let image_base64 = BASE64_STANDARD.encode(&image_bytes);

    let target = map_image_target_language(&config.target_language);
    let payload = serde_json::json!({
        "Data": image_base64,
        "Target": target,
    })
    .to_string();

    let body = post_tmt_api(secret_id, secret_key, region, "ImageTranslateLLM", payload).await?;
    let data: TencentImageTranslateResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Tencent parse response failed: {}, body: {}",
            e, body
        )
    })?;

    if let Some(error) = &data.error {
        return Err(format!(
            "[ocr_detect_online] Tencent error {}: {}",
            error.code, error.message
        ));
    }

    let text_blocks = data
        .trans_details
        .iter()
        .filter_map(|detail| {
            let bounding_box = detail.bounding_box.as_ref()?;
            if detail.target_line_text.is_empty() {
                return None;
            }

            Some(TextBlock {
                box_points: rect_to_box_points(
                    bounding_box.x as f64,
                    bounding_box.y as f64,
                    bounding_box.width as f64,
                    bounding_box.height as f64,
                ),
                box_score: 1.0,
                angle_index: 0,
                angle_score: 0.0,
                text: detail.target_line_text.clone(),
                text_score: 1.0,
            })
        })
        .collect();

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}
