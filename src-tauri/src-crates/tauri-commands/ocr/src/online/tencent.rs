use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use paddle_ocr_rs::ocr_result::{Point, TextBlock};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::OnlineOcrConfig;
use super::build_http_client;
use super::clamp_to_u32;
use super::hmac_sha256;
use super::prepare_image_bytes;
use super::utc_date_from_unix;
use crate::OcrDetectResult;

const TENCENT_OCR_ENDPOINT: &str = "https://ocr.tencentcloudapi.com";
const TENCENT_OCR_HOST: &str = "ocr.tencentcloudapi.com";
const TENCENT_OCR_SERVICE: &str = "ocr";
const TENCENT_OCR_VERSION: &str = "2018-11-19";
const TENCENT_MAX_BASE64_LENGTH: usize = 9_500_000;
const TENCENT_DEFAULT_REGION: &str = "ap-guangzhou";

#[derive(Deserialize)]
struct TencentOcrResponse {
    #[serde(rename = "Response", default)]
    response: Option<TencentOcrResponseData>,
}

#[derive(Deserialize)]
struct TencentOcrResponseData {
    #[serde(rename = "TextDetections", default)]
    text_detections: Vec<TencentTextDetection>,
    #[serde(rename = "Error", default)]
    error: Option<TencentApiError>,
}

#[derive(Deserialize)]
struct TencentApiError {
    #[serde(rename = "Code", default)]
    code: String,
    #[serde(rename = "Message", default)]
    message: String,
}

#[derive(Deserialize)]
struct TencentTextDetection {
    #[serde(rename = "DetectedText", default)]
    detected_text: String,
    #[serde(rename = "Polygon", default)]
    polygon: Vec<TencentPoint>,
    #[serde(rename = "Confidence", default)]
    confidence: i64,
}

#[derive(Deserialize)]
struct TencentPoint {
    #[serde(rename = "X", default)]
    x: i64,
    #[serde(rename = "Y", default)]
    y: i64,
}

pub(super) async fn detect_with_tencent(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<OcrDetectResult, String> {
    // 凭据去除首尾空白，避免复制粘贴引入空格导致签名校验失败
    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err("[ocr_detect_online] Tencent SecretId or SecretKey is empty".to_string());
    }

    let action = config
        .service_type
        .strip_prefix(super::TENCENT_SERVICE_TYPE_PREFIX)
        .unwrap_or("GeneralBasicOCR");

    let image_bytes = prepare_image_bytes(image, u32::MAX, TENCENT_MAX_BASE64_LENGTH)?;
    let image_base64 = BASE64_STANDARD.encode(&image_bytes);

    let mut body = serde_json::Map::new();
    body.insert(
        "ImageBase64".to_string(),
        serde_json::Value::String(image_base64),
    );
    if action == "GeneralAccurateOCR" {
        // 高精度版通过 ConfigID 控制识别场景：OCR 通用场景（中英文），MulOCR 多语种场景
        let config_id = if config.language == "mul" {
            "MulOCR"
        } else {
            "OCR"
        };
        body.insert(
            "ConfigID".to_string(),
            serde_json::Value::String(config_id.to_string()),
        );
    } else {
        let language = if config.language.is_empty() {
            "auto".to_string()
        } else {
            config.language.clone()
        };
        body.insert(
            "LanguageType".to_string(),
            serde_json::Value::String(language),
        );
    }
    let payload = serde_json::Value::Object(body).to_string();

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("[ocr_detect_online] Failed to get current time: {}", e))?;
    let timestamp = now.as_secs();
    let date = utc_date_from_unix(timestamp);
    let region = if config.region.is_empty() {
        TENCENT_DEFAULT_REGION.to_string()
    } else {
        config.region.clone()
    };

    // TC3-HMAC-SHA256 签名
    let hashed_payload = hex::encode(Sha256::digest(payload.as_bytes()));
    // CanonicalHeaders 每行以 \n 结尾，与 SignedHeaders 之间还需再分隔一个空行
    let canonical_request = format!(
        "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{}\nx-tc-action:{}\n\ncontent-type;host;x-tc-action\n{}",
        TENCENT_OCR_HOST,
        action.to_lowercase(),
        hashed_payload
    );
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{}\n{}/{}/tc3_request\n{}",
        timestamp,
        date,
        TENCENT_OCR_SERVICE,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );

    // 派生签名密钥：TC3+SecretKey -> 日期 -> 服务名 -> "tc3_request"
    let secret_date = hmac_sha256(format!("TC3{}", secret_key).as_bytes(), date.as_bytes())?;
    let secret_service = hmac_sha256(&secret_date, TENCENT_OCR_SERVICE.as_bytes())?;
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request")?;
    let signature = hex::encode(hmac_sha256(
        &secret_signing,
        string_to_sign.as_bytes(),
    )?);

    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={}/{}/{}/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature={}",
        secret_id, date, TENCENT_OCR_SERVICE, signature
    );

    let client = build_http_client()?;
    let response = client
        .post(TENCENT_OCR_ENDPOINT)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("X-TC-Action", action)
        .header("X-TC-Version", TENCENT_OCR_VERSION)
        .header("X-TC-Timestamp", timestamp.to_string())
        .header("X-TC-Region", region)
        .header("Authorization", authorization)
        .body(payload)
        .send()
        .await
        .map_err(|e| format!("[ocr_detect_online] Tencent request failed: {}", e))?;

    let body = response
        .text()
        .await
        .map_err(|e| format!("[ocr_detect_online] Tencent read response failed: {}", e))?;

    let ocr_response: TencentOcrResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Tencent parse response failed: {}, body: {}",
            e, body
        )
    })?;

    let response_data = ocr_response
        .response
        .ok_or("[ocr_detect_online] Tencent empty response")?;
    if let Some(error) = &response_data.error {
        return Err(format!(
            "[ocr_detect_online] Tencent error {}: {}",
            error.code, error.message
        ));
    }

    let mut text_blocks = Vec::new();
    for detection in &response_data.text_detections {
        if detection.polygon.len() < 4 {
            continue;
        }

        let text_score = if detection.confidence <= 0 {
            1.0
        } else {
            detection.confidence as f32 / 100.0
        };
        text_blocks.push(TextBlock {
            box_points: detection
                .polygon
                .iter()
                .map(|point| Point {
                    x: clamp_to_u32(point.x as f64),
                    y: clamp_to_u32(point.y as f64),
                })
                .collect(),
            box_score: text_score,
            angle_index: 0,
            angle_score: 0.0,
            text: detection.detected_text.clone(),
            text_score,
        });
    }

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}
