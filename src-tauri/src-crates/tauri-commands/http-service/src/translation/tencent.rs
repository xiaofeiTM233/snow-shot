//! 腾讯云机器翻译：文本翻译 + 端到端图片翻译（TC3-HMAC-SHA256 签名）

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::MachineTranslatedImageLine;
use super::build_http_client;
use super::clamp_to_u32;
use super::now_unix_secs;

type HmacSha256 = Hmac<Sha256>;

const TENCENT_TMT_ENDPOINT: &str = "https://tmt.tencentcloudapi.com";
const TENCENT_TMT_HOST: &str = "tmt.tencentcloudapi.com";
const TENCENT_TMT_SERVICE: &str = "tmt";
const TENCENT_TMT_VERSION: &str = "2018-03-21";
const TENCENT_DEFAULT_REGION: &str = "ap-guangzhou";
/// 单条文本长度需低于 6000 字符
const TENCENT_TEXT_MAX_CHARS: usize = 6000;
/// 图片 Base64 编码后最大 9M
const TENCENT_IMAGE_MAX_BASE64_LENGTH: usize = 9_000_000;
/// 腾讯云文本翻译限频 5 次/秒
const TENCENT_REQUEST_INTERVAL_MS: u64 = 220;

#[derive(Debug, Clone, Deserialize)]
pub(super) struct TencentImageTranslateConfig {
    /// 腾讯云 SecretId
    #[serde(default)]
    pub secret_id: String,
    /// 腾讯云 SecretKey
    #[serde(default)]
    pub secret_key: String,
    /// 腾讯云 地域
    #[serde(default)]
    pub region: String,
    /// 目标语言
    #[serde(default)]
    pub to: String,
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let mut mac =
        HmacSha256::new_from_slice(key).map_err(|e| format!("Failed to create hmac: {}", e))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

/// 由 Unix 时间戳计算 UTC 日期（yyyy-MM-dd），用于 TC3 签名
fn utc_date_from_unix(timestamp: u64) -> String {
    let days = (timestamp / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// 应用代码转腾讯云语言代码（zh-CHS -> zh、zh-CHT -> zh-TW，其余透传）
fn map_tencent_language(code: &str) -> String {
    match code {
        "zh-CHS" => "zh".to_string(),
        "zh-CHT" => "zh-TW".to_string(),
        other => other.to_string(),
    }
}

/// 腾讯云 TMT 接口请求：TC3-HMAC-SHA256 签名，返回原始响应文本
async fn tencent_tmt_request(
    context: &str,
    action: &str,
    payload: String,
    secret_id: &str,
    secret_key: &str,
    region: &str,
) -> Result<String, String> {
    let timestamp = now_unix_secs()?;
    let date = utc_date_from_unix(timestamp);

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
        .map_err(|e| format!("{} Tencent request failed: {}", context, e))?;

    response
        .text()
        .await
        .map_err(|e| format!("{} Tencent read response failed: {}", context, e))
}

#[derive(Deserialize)]
#[serde(bound(deserialize = "T: serde::de::Deserialize<'de>"))]
struct TencentTmtResponse<T> {
    #[serde(rename = "Response", default)]
    response: Option<T>,
}

#[derive(Deserialize)]
struct TencentTmtError {
    #[serde(rename = "Code", default)]
    code: String,
    #[serde(rename = "Message", default)]
    message: String,
}

/// 腾讯云文本翻译：接口限频 5 次/秒，逐条请求
pub async fn translate_text_tencent(
    secret_id: String,
    secret_key: String,
    region: String,
    texts: Vec<String>,
    from: String,
    to: String,
) -> Result<Vec<String>, String> {
    let context = "[translate_text_tencent]";
    let secret_id = secret_id.trim();
    let secret_key = secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err(format!(
            "{} Tencent SecretId or SecretKey is empty",
            context
        ));
    }
    if from == "auto" {
        return Err(format!(
            "{} Tencent text translation does not support auto source language",
            context
        ));
    }

    let region = if region.trim().is_empty() {
        TENCENT_DEFAULT_REGION.to_string()
    } else {
        region.trim().to_string()
    };
    let source = map_tencent_language(&from);
    let target = map_tencent_language(&to);

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
    config: TencentImageTranslateConfig,
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
