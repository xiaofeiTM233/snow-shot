use std::time::{SystemTime, UNIX_EPOCH};

use base64::prelude::*;
use chrono::{TimeZone, Utc};
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// 与前端 `OcrDetectResult` 保持一致的序列化结构
#[derive(serde::Serialize)]
pub struct OnlineOcrPoint {
    pub x: f32,
    pub y: f32,
}

#[derive(serde::Serialize)]
pub struct OnlineOcrTextBlock {
    pub box_points: Vec<OnlineOcrPoint>,
    pub text: String,
    pub text_score: f32,
}

#[derive(serde::Serialize)]
pub struct OnlineOcrDetectResult {
    pub text_blocks: Vec<OnlineOcrTextBlock>,
    pub scale_factor: f32,
}

/// 与前端 `OnlineOcrConfig` 字段一一对应
#[derive(Deserialize)]
pub struct OnlineOcrConfig {
    pub model_name: String,
    pub provider: String,
    pub service_type: String,
    pub language: String,
    pub youdao_app_key: String,
    pub youdao_app_secret: String,
    pub tencent_secret_id: String,
    pub tencent_secret_key: String,
    pub tencent_region: String,
}

pub async fn online_ocr_detect(
    request: tauri::ipc::Request<'_>,
) -> Result<OnlineOcrDetectResult, String> {
    let image_data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data.to_vec(),
        _ => return Err("[online_ocr_detect] Invalid request body".to_string()),
    };

    let config_header = request
        .headers()
        .get("x-online-ocr-config")
        .ok_or("[online_ocr_detect] Missing online ocr config")?
        .to_str()
        .map_err(|_| "[online_ocr_detect] Invalid config header".to_string())?;

    let config: OnlineOcrConfig = serde_json::from_str(config_header)
        .map_err(|e| format!("[online_ocr_detect] Failed to parse config: {}", e))?;

    match config.provider.as_str() {
        "youdao" => youdao_ocr(&image_data, &config).await,
        "tencent" => tencent_ocr(&image_data, &config).await,
        other => Err(format!(
            "[online_ocr_detect] Unknown provider: {}",
            other
        )),
    }
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn random_salt() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    SystemTime::now().hash(&mut hasher);
    format!("{}", hasher.finish())
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac init");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// 将 "x1,y1,x2,y2,x3,y3,x4,y4" 解析为 4 个顶点
fn parse_box_8(s: &str) -> Vec<OnlineOcrPoint> {
    let nums: Vec<f32> = s
        .split(',')
        .filter_map(|p| p.trim().parse::<f32>().ok())
        .collect();

    let mut points = Vec::with_capacity(4);
    let mut i = 0;
    while i + 1 < nums.len() {
        points.push(OnlineOcrPoint {
            x: nums[i],
            y: nums[i + 1],
        });
        i += 2;
    }
    points
}

// ===================== 有道智云 =====================

async fn youdao_ocr(
    image: &[u8],
    config: &OnlineOcrConfig,
) -> Result<OnlineOcrDetectResult, String> {
    let img_b64 = BASE64_STANDARD.encode(image);
    let salt = random_salt();
    let curtime = current_timestamp().to_string();

    // v3 签名：sha256(appKey + input + salt + curtime + appSecret)
    // input：img 长度 > 20 时取前 10 + 长度 + 后 10，否则取整个 img
    let input: String = if img_b64.len() > 20 {
        format!(
            "{}{}{}",
            &img_b64[..10],
            img_b64.len(),
            &img_b64[img_b64.len() - 10..]
        )
    } else {
        img_b64.clone()
    };
    let sign_raw = format!(
        "{}{}{}{}{}",
        config.youdao_app_key, input, salt, curtime, config.youdao_app_secret
    );
    let sign = sha256_hex(sign_raw.as_bytes());

    let lang_type = if config.language.is_empty() {
        "auto".to_string()
    } else {
        config.language.clone()
    };

    let params = [
        ("img", img_b64.as_str()),
        ("appKey", config.youdao_app_key.as_str()),
        ("salt", salt.as_str()),
        ("curtime", curtime.as_str()),
        ("sign", sign.as_str()),
        ("signType", "v3"),
        ("detectType", "10012"),
        ("type", config.service_type.as_str()),
        ("langType", lang_type.as_str()),
        ("imageType", "1"),
        ("docType", "json"),
    ];

    let client = Client::new();
    let resp = client
        .post("https://openapi.youdao.com/ocrapi")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("[youdao_ocr] Request failed: {}", e))?;

    let body = resp
        .text()
        .await
        .map_err(|e| format!("[youdao_ocr] Read body failed: {}", e))?;

    parse_youdao_response(&body)
}

fn parse_youdao_response(body: &str) -> Result<OnlineOcrDetectResult, String> {
    let v: Value =
        serde_json::from_str(body).map_err(|e| format!("[youdao_ocr] Invalid JSON: {}", e))?;

    if let Some(code) = v.get("errorCode").and_then(|c| c.as_str()) {
        if code != "0" {
            let msg = v
                .get("errorMsg")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown");
            return Err(format!("[youdao_ocr] API error {}: {}", code, msg));
        }
    }

    let result = v
        .get("Result")
        .ok_or("[youdao_ocr] Missing Result field")?;

    let mut blocks = Vec::new();
    if let Some(regions) = result.get("regions").and_then(|r| r.as_array()) {
        for region in regions {
            if let Some(lines) = region.get("lines").and_then(|l| l.as_array()) {
                for line in lines {
                    let text = line
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    let box_str = line
                        .get("boundingBox")
                        .and_then(|b| b.as_str())
                        .unwrap_or("");
                    blocks.push(OnlineOcrTextBlock {
                        box_points: parse_box_8(box_str),
                        text,
                        text_score: 1.0,
                    });
                }
            }
        }
    }

    Ok(OnlineOcrDetectResult {
        text_blocks: blocks,
        scale_factor: 1.0,
    })
}

// ===================== 腾讯云 =====================

async fn tencent_ocr(
    image: &[u8],
    config: &OnlineOcrConfig,
) -> Result<OnlineOcrDetectResult, String> {
    let img_b64 = BASE64_STANDARD.encode(image);

    let action = match config.service_type.as_str() {
        "general_accurate" => "GeneralAccurateOCR",
        _ => "GeneralBasicOCR",
    };
    let region = "ap-guangzhou";
    let language_type = map_tencent_language(&config.language);

    let body = json!({
        "ImageBase64": img_b64,
        "LanguageType": language_type,
    });
    let body_str = body.to_string();

    let timestamp = current_timestamp();
    let authorization = tencent_sign(
        &config.tencent_secret_id,
        &config.tencent_secret_key,
        &body_str,
        action,
        region,
        timestamp,
    )?;

    let client = Client::new();
    let resp = client
        .post("https://ocr.tencentcloudapi.com")
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Host", "ocr.tencentcloudapi.com")
        .header("X-TC-Action", action)
        .header("X-TC-Region", region)
        .header("X-TC-Timestamp", timestamp.to_string())
        .header("X-TC-Version", "2018-11-19")
        .header("Authorization", authorization)
        .body(body_str)
        .send()
        .await
        .map_err(|e| format!("[tencent_ocr] Request failed: {}", e))?;

    let body = resp
        .text()
        .await
        .map_err(|e| format!("[tencent_ocr] Read body failed: {}", e))?;

    parse_tencent_response(&body)
}

fn map_tencent_language(lang: &str) -> String {
    match lang {
        "zh-CHS" | "zh-CHT" => "zh",
        "ja" => "jap",
        "ko" => "kor",
        "fr" => "fre",
        "de" => "ger",
        "es" => "spa",
        "pt" => "por",
        "it" => "ita",
        "ru" => "rus",
        "ar" => "ara",
        "en" => "auto",
        "" | "auto" => "auto",
        other => other,
    }
    .to_string()
}

fn tencent_sign(
    secret_id: &str,
    secret_key: &str,
    payload: &str,
    action: &str,
    region: &str,
    timestamp: u64,
) -> Result<String, String> {
    let host = "ocr.tencentcloudapi.com";
    let service = "ocr";
    let date = Utc
        .timestamp_opt(timestamp as i64, 0)
        .unwrap()
        .format("%Y%m%d")
        .to_string();

    let hashed_payload = sha256_hex(payload.as_bytes());
    let canonical_headers = format!("content-type:application/json; charset=utf-8\nhost:{}\n", host);
    let signed_headers = "content-type;host";
    let canonical_request = format!(
        "POST\n/\n\n{}\n{}\n{}",
        canonical_headers, signed_headers, hashed_payload
    );

    let credential_scope = format!("{}/{}/tc3_request", date, service);
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{}\n{}\n{}",
        timestamp,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );

    let secret_date = hmac_sha256(format!("TC3{}", secret_key).as_bytes(), date.as_bytes());
    let secret_service = hmac_sha256(&secret_date, service.as_bytes());
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request");
    let signature = hex::encode(hmac_sha256(
        &secret_signing,
        string_to_sign.as_bytes(),
    ));

    Ok(format!(
        "TC3-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        secret_id, credential_scope, signed_headers, signature
    ))
}

fn parse_tencent_response(body: &str) -> Result<OnlineOcrDetectResult, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| format!("[tencent_ocr] Invalid JSON: {}", e))?;

    let response = v
        .get("Response")
        .ok_or("[tencent_ocr] Missing Response field")?;

    if let Some(err) = response.get("Error") {
        let code = err
            .get("Code")
            .and_then(|c| c.as_str())
            .unwrap_or("");
        let msg = err
            .get("Message")
            .and_then(|m| m.as_str())
            .unwrap_or("");
        return Err(format!("[tencent_ocr] API error {}: {}", code, msg));
    }

    let mut blocks = Vec::new();
    if let Some(dets) = response
        .get("TextDetections")
        .and_then(|d| d.as_array())
    {
        for det in dets {
            let text = det
                .get("DetectedText")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            let score = det
                .get("Confidence")
                .and_then(|c| c.as_f64())
                .unwrap_or(0.0) as f32
                / 100.0;

            let mut points = Vec::new();
            if let Some(poly) = det.get("Polygon").and_then(|p| p.as_array()) {
                for p in poly {
                    let x = p
                        .get("X")
                        .and_then(|x| x.as_f64())
                        .unwrap_or(0.0) as f32;
                    let y = p
                        .get("Y")
                        .and_then(|y| y.as_f64())
                        .unwrap_or(0.0) as f32;
                    points.push(OnlineOcrPoint { x, y });
                }
            }

            blocks.push(OnlineOcrTextBlock {
                box_points: points,
                text,
                text_score: score,
            });
        }
    }

    Ok(OnlineOcrDetectResult {
        text_blocks: blocks,
        scale_factor: 1.0,
    })
}
