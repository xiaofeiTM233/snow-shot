use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use paddle_ocr_rs::ocr_result::{Point, TextBlock};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::prepare_image_bytes;
use super::rect_to_box_points;
use super::OnlineOcrConfig;
use crate::common::build_http_client;
use crate::common::clamp_to_u32;
use crate::common::hmac_sha256;
use crate::common::utc_date_from_unix;
use snow_shot_app_services::ocr_service::OcrDetectResult;

const VOLC_OCR_ENDPOINT: &str = "https://visual.volcengineapi.com/";
const VOLC_OCR_HOST: &str = "visual.volcengineapi.com";
const VOLC_OCR_ACTION: &str = "OCRNormal";
const VOLC_OCR_VERSION: &str = "2020-08-26";
const VOLC_OCR_REGION: &str = "cn-north-1";
const VOLC_OCR_SERVICE: &str = "cv";
const VOLC_MAX_BASE64_LENGTH: usize = 8_000_000;

#[derive(Deserialize)]
struct VolcOcrResponse {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
    #[serde(rename = "ResponseMetadata", default)]
    response_metadata: Option<VolcResponseMetadata>,
    #[serde(default)]
    data: Option<VolcOcrData>,
}

#[derive(Deserialize)]
struct VolcResponseMetadata {
    #[serde(default)]
    error: Option<VolcApiError>,
}

#[derive(Deserialize)]
struct VolcApiError {
    #[serde(rename = "Code", default)]
    code: String,
    #[serde(rename = "Message", default)]
    message: String,
}

#[derive(Deserialize)]
struct VolcOcrData {
    #[serde(rename = "line_texts", default)]
    line_texts: Vec<String>,
    #[serde(rename = "line_rects", default)]
    line_rects: Vec<VolcRect>,
    #[serde(default)]
    polygons: Vec<Vec<Vec<f64>>>,
}

#[derive(Deserialize)]
struct VolcRect {
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    #[serde(default)]
    width: f64,
    #[serde(default)]
    height: f64,
}

pub(super) async fn detect_with_volc(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<OcrDetectResult, String> {
    // 凭据去除首尾空白，避免复制粘贴引入空格导致签名校验失败
    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err(
            "[ocr_detect_online] Volcengine AccessKeyId or SecretAccessKey is empty".to_string(),
        );
    }

    let image_bytes = prepare_image_bytes(image, u32::MAX, VOLC_MAX_BASE64_LENGTH)?;
    let image_base64 = BASE64_STANDARD.encode(&image_bytes);
    // 表单体中的 base64 值需要 urlencode
    let body = format!(
        "image_base64={}",
        image_base64
            .replace('+', "%2B")
            .replace('/', "%2F")
            .replace('=', "%3D")
    );
    let body_hash = hex::encode(Sha256::digest(body.as_bytes()));

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("[ocr_detect_online] Failed to get current time: {}", e))?;
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

    // 火山引擎 V4 签名（HMAC-SHA256）
    let query = format!("Action={}&Version={}", VOLC_OCR_ACTION, VOLC_OCR_VERSION);
    let signed_headers = "content-type;host;x-content-sha256;x-date";
    let canonical_headers = format!(
        "content-type:application/x-www-form-urlencoded\nhost:{}\nx-content-sha256:{}\nx-date:{}\n",
        VOLC_OCR_HOST, body_hash, x_date
    );
    let canonical_request = format!(
        "POST\n/\n{}\n{}\n{}\n{}",
        query, canonical_headers, signed_headers, body_hash
    );
    let credential_scope = format!(
        "{}/{}/{}/request",
        short_date, VOLC_OCR_REGION, VOLC_OCR_SERVICE
    );
    let string_to_sign = format!(
        "HMAC-SHA256\n{}\n{}\n{}",
        x_date,
        credential_scope,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );

    // 派生签名密钥：SecretAccessKey -> 日期 -> 地域 -> 服务 -> "request"
    let k_date = hmac_sha256(secret_key.as_bytes(), short_date.as_bytes())?;
    let k_region = hmac_sha256(&k_date, VOLC_OCR_REGION.as_bytes())?;
    let k_service = hmac_sha256(&k_region, VOLC_OCR_SERVICE.as_bytes())?;
    let k_signing = hmac_sha256(&k_service, b"request")?;
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes())?);

    let authorization = format!(
        "HMAC-Credential Credential={}/{}, SignedHeaders={}, Signature={}",
        secret_id, credential_scope, signed_headers, signature
    );

    let client = build_http_client()?;
    let response = client
        .post(VOLC_OCR_ENDPOINT)
        .query(&[("Action", VOLC_OCR_ACTION), ("Version", VOLC_OCR_VERSION)])
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("X-Date", &x_date)
        .header("X-Content-Sha256", &body_hash)
        .header("Authorization", authorization)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("[ocr_detect_online] Volcengine request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("[ocr_detect_online] Volcengine read response failed: {}", e))?;

    let ocr_response: VolcOcrResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Volcengine parse response failed: {}, status: {}, body: {}",
            e, status, body
        )
    })?;

    if let Some(metadata) = &ocr_response.response_metadata {
        if let Some(error) = &metadata.error {
            return Err(format!(
                "[ocr_detect_online] Volcengine error {}: {}",
                error.code, error.message
            ));
        }
    }

    if ocr_response.code != 0 {
        return Err(format!(
            "[ocr_detect_online] Volcengine error {}: {}",
            ocr_response.code, ocr_response.message
        ));
    }

    let Some(data) = &ocr_response.data else {
        return Ok(OcrDetectResult {
            text_blocks: Vec::new(),
            scale_factor: 1.0,
        });
    };

    let mut text_blocks = Vec::new();
    for (index, line_text) in data.line_texts.iter().enumerate() {
        // 优先使用 polygons（四点外接框，携带旋转信息），缺省时退回 line_rects（矩形）
        let mut box_points: Option<Vec<Point>> = None;
        if let Some(polygon) = data.polygons.get(index) {
            if polygon.len() >= 4 {
                box_points = Some(
                    polygon[..4]
                        .iter()
                        .map(|point| Point {
                            x: clamp_to_u32(point.first().copied().unwrap_or(0.0)),
                            y: clamp_to_u32(point.get(1).copied().unwrap_or(0.0)),
                        })
                        .collect(),
                );
            }
        }
        if box_points.is_none() {
            if let Some(rect) = data.line_rects.get(index) {
                box_points = Some(rect_to_box_points(rect.x, rect.y, rect.width, rect.height));
            }
        }
        let Some(box_points) = box_points else {
            continue;
        };

        text_blocks.push(TextBlock {
            box_points,
            box_score: 1.0,
            angle_index: 0,
            angle_score: 0.0,
            text: line_text.clone(),
            text_score: 1.0,
        });
    }

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}
