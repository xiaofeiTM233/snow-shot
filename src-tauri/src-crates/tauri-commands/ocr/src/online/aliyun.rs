use std::time::{SystemTime, UNIX_EPOCH};

use paddle_ocr_rs::ocr_result::{Point, TextBlock};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::OnlineOcrConfig;
use super::build_http_client;
use super::clamp_to_u32;
use super::hmac_sha256;
use super::prepare_image_bytes;
use super::utc_datetime_from_unix;
use crate::OcrDetectResult;

const ALIYUN_OCR_ENDPOINT: &str = "https://ocr-api.cn-hangzhou.aliyuncs.com/";
const ALIYUN_OCR_HOST: &str = "ocr-api.cn-hangzhou.aliyuncs.com";
const ALIYUN_OCR_VERSION: &str = "2021-07-07";
const ALIYUN_MAX_BASE64_LENGTH: usize = 9_500_000;

#[derive(Deserialize)]
struct AliyunOcrResponse {
    /// Data 为内嵌 JSON 的字符串
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct AliyunOcrData {
    #[serde(rename = "prism_wordsInfo", default)]
    prism_words_info: Vec<AliyunWordInfo>,
}

#[derive(Deserialize)]
struct AliyunWordInfo {
    #[serde(default)]
    word: String,
    /// 外接矩形四点坐标，顺时针：左上、右上、右下、左下
    #[serde(default)]
    pos: Vec<AliyunPoint>,
}

#[derive(Deserialize)]
struct AliyunPoint {
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
}

pub(super) async fn detect_with_aliyun(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<OcrDetectResult, String> {
    // 凭据去除首尾空白，避免复制粘贴引入空格导致签名校验失败
    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err("[ocr_detect_online] Aliyun AccessKeyId or AccessKeySecret is empty".to_string());
    }

    let action = config
        .service_type
        .strip_prefix(super::ALIYUN_SERVICE_TYPE_PREFIX)
        .unwrap_or("RecognizeGeneral");

    let image_bytes = prepare_image_bytes(image, u32::MAX, ALIYUN_MAX_BASE64_LENGTH)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("[ocr_detect_online] Failed to get current time: {}", e))?;
    let timestamp = now.as_secs();
    let x_date = utc_datetime_from_unix(timestamp);
    // 随机数用于防重放
    let nonce = hex::encode(Sha256::digest(format!(
        "{}{}{}",
        timestamp,
        now.subsec_nanos(),
        std::process::id()
    )))[..32]
        .to_string();

    // ACS3-HMAC-SHA256 签名：图片二进制作为请求体
    let payload_hash = hex::encode(Sha256::digest(&image_bytes));
    let query = format!("Action={}&Version={}", action, ALIYUN_OCR_VERSION);
    let signed_headers =
        "content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version";
    let canonical_headers = format!(
        "content-type:application/octet-stream\nhost:{}\nx-acs-action:{}\nx-acs-content-sha256:{}\nx-acs-date:{}\nx-acs-signature-nonce:{}\nx-acs-version:{}\n",
        ALIYUN_OCR_HOST, action, payload_hash, x_date, nonce, ALIYUN_OCR_VERSION
    );
    let canonical_request = format!(
        "POST\n/\n{}\n{}\n{}\n{}",
        query, canonical_headers, signed_headers, payload_hash
    );
    let string_to_sign = format!(
        "ACS3-HMAC-SHA256\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let signature = hex::encode(hmac_sha256(secret_key.as_bytes(), string_to_sign.as_bytes())?);
    let authorization = format!(
        "ACS3-HMAC-SHA256 Credential={},SignedHeaders={},Signature={}",
        secret_id, signed_headers, signature
    );

    let client = build_http_client()?;
    let response = client
        .post(ALIYUN_OCR_ENDPOINT)
        .query(&[("Action", action), ("Version", ALIYUN_OCR_VERSION)])
        .header("Content-Type", "application/octet-stream")
        .header("x-acs-action", action)
        .header("x-acs-content-sha256", &payload_hash)
        .header("x-acs-date", &x_date)
        .header("x-acs-signature-nonce", &nonce)
        .header("x-acs-version", ALIYUN_OCR_VERSION)
        .header("Authorization", authorization)
        .body(image_bytes)
        .send()
        .await
        .map_err(|e| format!("[ocr_detect_online] Aliyun request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("[ocr_detect_online] Aliyun read response failed: {}", e))?;

    let ocr_response: AliyunOcrResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Aliyun parse response failed: {}, status: {}, body: {}",
            e, status, body
        )
    })?;

    if let Some(code) = &ocr_response.code {
        return Err(format!(
            "[ocr_detect_online] Aliyun error {}: {}",
            code,
            ocr_response.message.unwrap_or_default()
        ));
    }

    // Data 为内嵌 JSON 的字符串，需要二次解析
    let Some(data) = &ocr_response.data else {
        return Ok(OcrDetectResult {
            text_blocks: Vec::new(),
            scale_factor: 1.0,
        });
    };
    let ocr_data: AliyunOcrData = serde_json::from_str(data).map_err(|e| {
        format!(
            "[ocr_detect_online] Aliyun parse data failed: {}, data: {}",
            e, data
        )
    })?;

    let mut text_blocks = Vec::new();
    for word_info in &ocr_data.prism_words_info {
        if word_info.pos.len() < 4 {
            continue;
        }

        text_blocks.push(TextBlock {
            box_points: word_info
                .pos
                .iter()
                .map(|point| Point {
                    x: clamp_to_u32(point.x),
                    y: clamp_to_u32(point.y),
                })
                .collect(),
            box_score: 1.0,
            angle_index: 0,
            angle_score: 0.0,
            text: word_info.word.clone(),
            text_score: 1.0,
        });
    }

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}
