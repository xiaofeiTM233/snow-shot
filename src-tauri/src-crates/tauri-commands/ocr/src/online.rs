use std::io::Cursor;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use hmac::{Hmac, Mac};
use paddle_ocr_rs::ocr_result::{Point, TextBlock};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::OcrDetectResult;

const YOUDAO_OCR_ENDPOINT: &str = "https://openapi.youdao.com/ocrapi";
const YOUDAO_SERVICE_TYPE_PREFIX: &str = "youdao:";
const YOUDAO_MAX_IMAGE_SIDE: u32 = 2048;
/// 有道限制 base64 编码后小于 2M
const YOUDAO_MAX_BASE64_LENGTH: usize = 2_000_000;

const TENCENT_OCR_ENDPOINT: &str = "https://ocr.tencentcloudapi.com";
const TENCENT_OCR_HOST: &str = "ocr.tencentcloudapi.com";
const TENCENT_OCR_SERVICE: &str = "ocr";
const TENCENT_OCR_VERSION: &str = "2018-11-19";
const TENCENT_SERVICE_TYPE_PREFIX: &str = "tencent:";
const TENCENT_MAX_BASE64_LENGTH: usize = 9_500_000;
const TENCENT_DEFAULT_REGION: &str = "ap-guangzhou";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineOcrConfig {
    /// 服务类型，格式为 `provider:service`，例如 `youdao:ocr`、`tencent:GeneralBasicOCR`
    pub service_type: String,
    /// 识别语言，取值跟随对应平台文档
    #[serde(default)]
    pub language: String,
    /// 有道 应用ID（appKey）
    #[serde(default)]
    pub app_key: String,
    /// 有道 应用密钥
    #[serde(default)]
    pub app_secret: String,
    /// 腾讯云 SecretId
    #[serde(default)]
    pub secret_id: String,
    /// 腾讯云 SecretKey
    #[serde(default)]
    pub secret_key: String,
    /// 腾讯云 地域
    #[serde(default)]
    pub region: String,
}

#[derive(Deserialize)]
struct YoudaoOcrResponse {
    #[serde(rename = "errorCode", default)]
    error_code: Option<String>,
    #[serde(rename = "Result", default)]
    result: Option<YoudaoOcrResult>,
}

#[derive(Deserialize)]
struct YoudaoOcrResult {
    #[serde(default)]
    regions: Vec<YoudaoOcrRegion>,
}

#[derive(Deserialize)]
struct YoudaoOcrRegion {
    #[serde(default)]
    lines: Vec<YoudaoOcrLine>,
}

#[derive(Deserialize)]
struct YoudaoOcrLine {
    #[serde(rename = "boundingBox", default)]
    bounding_box: String,
    #[serde(default)]
    text: String,
}

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

pub async fn ocr_detect_online(
    request: tauri::ipc::Request<'_>,
) -> Result<OcrDetectResult, String> {
    log::info!("[ocr_detect_online] start detect");

    let config_header = request
        .headers()
        .get("x-ocr-config")
        .ok_or("[ocr_detect_online] Missing ocr config header")?
        .to_str()
        .map_err(|_| "[ocr_detect_online] Invalid ocr config header")?;
    let config_json = percent_decode_str(config_header)
        .decode_utf8()
        .map_err(|e| format!("[ocr_detect_online] Failed to decode ocr config: {}", e))?;
    let config: OnlineOcrConfig = serde_json::from_str(&config_json)
        .map_err(|e| format!("[ocr_detect_online] Failed to parse ocr config: {}", e))?;

    let image_data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data,
        _ => return Err("[ocr_detect_online] Invalid request body".to_string()),
    };

    let detect_angle = request
        .headers()
        .get("x-detect-angle")
        .and_then(|value| value.to_str().ok())
        .map(|value| value == "true")
        .unwrap_or(false);

    let image = image::load(Cursor::new(image_data), image::ImageFormat::Png)
        .map_err(|_| "[ocr_detect_online] Invalid image".to_string())?;

    if config.service_type.starts_with(YOUDAO_SERVICE_TYPE_PREFIX) {
        detect_with_youdao(&config, &image, detect_angle).await
    } else if config.service_type.starts_with(TENCENT_SERVICE_TYPE_PREFIX) {
        detect_with_tencent(&config, &image).await
    } else {
        Err(format!(
            "[ocr_detect_online] Unknown service type: {}",
            config.service_type
        ))
    }
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("[ocr_detect_online] Failed to build http client: {}", e))
}

/// 压缩图片以满足在线平台的限制：超过最大边长时等比缩放，体积仍超限时降级为 JPEG
fn prepare_image_bytes(
    image: &image::DynamicImage,
    max_side: u32,
    max_base64_length: usize,
) -> Result<Vec<u8>, String> {
    // 拒绝无有效尺寸的图片，避免后续缩放与编码产生异常结果
    if image.width() == 0 || image.height() == 0 {
        return Err("[ocr_detect_online] Invalid image size".to_string());
    }

    let mut img = image.clone();
    let longest_side = img.width().max(img.height());
    if longest_side > max_side {
        let scale = max_side as f32 / longest_side as f32;
        img = img.resize(
            ((img.width() as f32 * scale) as u32).max(1),
            ((img.height() as f32 * scale) as u32).max(1),
            image::imageops::FilterType::Lanczos3,
        );
    }

    let mut png_bytes = Vec::new();
    img.write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("[ocr_detect_online] Failed to encode image: {}", e))?;

    if BASE64_STANDARD.encode(&png_bytes).len() < max_base64_length {
        return Ok(png_bytes);
    }

    for quality in [90u8, 80u8] {
        let mut jpeg_bytes = Vec::new();
        let encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, quality);
        img.write_with_encoder(encoder)
            .map_err(|e| format!("[ocr_detect_online] Failed to encode image: {}", e))?;
        if BASE64_STANDARD.encode(&jpeg_bytes).len() < max_base64_length {
            return Ok(jpeg_bytes);
        }
    }

    Err("[ocr_detect_online] Image is too large to send".to_string())
}

/// 将坐标收敛到 u32 范围；超出 u32::MAX 的浮点值直接取上限，
/// 避免 round() 后的 float->int 转换受精度影响
fn clamp_to_u32(value: f64) -> u32 {
    if value.is_nan() || value <= 0.0 {
        0
    } else if value >= u32::MAX as f64 {
        u32::MAX
    } else {
        value.round() as u32
    }
}

/// 有道 boundingBox 为逗号分隔的 8 个数值：左上(x,y)、右上(x,y)、右下(x,y)、左下(x,y)
fn parse_youdao_bounding_box(bounding_box: &str) -> Option<Vec<Point>> {
    let values: Vec<f64> = bounding_box
        .split(',')
        .filter_map(|value| value.trim().parse::<f64>().ok())
        .collect();
    if values.len() < 8 {
        return None;
    }

    Some(
        values[..8]
            .chunks(2)
            .map(|chunk| Point {
                x: clamp_to_u32(chunk[0]),
                y: clamp_to_u32(chunk[1]),
            })
            .collect(),
    )
}

fn youdao_error_message(code: &str) -> &'static str {
    match code {
        "101" => "缺少必填参数或参数书写错误",
        "102" => "不支持的语言类型",
        "108" => "应用ID无效",
        "110" => "应用未绑定相关服务",
        "111" => "开发者账号无效",
        "113" => "图片不能为空",
        "114" => "不支持的图片传输方式",
        "201" => "签名解密失败",
        "202" => "签名校验失败，请检查应用密钥",
        "203" => "IP不在可访问列表",
        "206" => "时间戳无效导致签名校验失败",
        "207" => "重放请求",
        "401" => "账户已欠费停",
        "411" | "1411" => "访问频率受限",
        "1001" => "无效的OCR类型",
        "1002" => "不支持的OCR image类型",
        "1003" => "不支持的Language类型",
        "1004" => "识别图片过大",
        "1006" => "图片不能为空",
        "1201" => "图片base64解密失败",
        _ => "未知错误",
    }
}

async fn detect_with_youdao(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
    detect_angle: bool,
) -> Result<OcrDetectResult, String> {
    // 凭据去除首尾空白，避免复制粘贴引入空格导致签名校验失败
    let app_key = config.app_key.trim();
    let app_secret = config.app_secret.trim();
    if app_key.is_empty() || app_secret.is_empty() {
        return Err("[ocr_detect_online] Youdao appKey or appSecret is empty".to_string());
    }

    let image_bytes = prepare_image_bytes(image, YOUDAO_MAX_IMAGE_SIDE, YOUDAO_MAX_BASE64_LENGTH)?;
    let img_base64 = BASE64_STANDARD.encode(&image_bytes);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("[ocr_detect_online] Failed to get current time: {}", e))?;
    let curtime = now.as_secs().to_string();
    let salt = format!("{:x}{}", now.subsec_nanos(), std::process::id());

    // 签名规则：sha256(appKey + input + salt + curtime + appSecret)
    // input：img 长度大于 20 时取前 10 个字符 + 长度 + 后 10 个字符
    let sign_input = if img_base64.len() > 20 {
        format!(
            "{}{}{}",
            &img_base64[..10],
            img_base64.len(),
            &img_base64[img_base64.len() - 10..]
        )
    } else {
        img_base64.clone()
    };
    let sign = hex::encode(Sha256::digest(format!(
        "{}{}{}{}{}",
        app_key, sign_input, salt, curtime, app_secret
    )));

    let language = if config.language.is_empty() {
        "auto".to_string()
    } else {
        config.language.clone()
    };

    let client = build_http_client()?;
    let response = client
        .post(YOUDAO_OCR_ENDPOINT)
        .form(&[
            ("img", img_base64.as_str()),
            ("imageType", "1"),
            ("detectType", "10012"),
            ("langType", language.as_str()),
            ("appKey", app_key),
            ("salt", salt.as_str()),
            ("curtime", curtime.as_str()),
            ("sign", sign.as_str()),
            ("docType", "json"),
            ("signType", "v3"),
            ("angle", if detect_angle { "1" } else { "0" }),
        ])
        .send()
        .await
        .map_err(|e| format!("[ocr_detect_online] Youdao request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("[ocr_detect_online] Youdao read response failed: {}", e))?;

    let ocr_response: YoudaoOcrResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Youdao parse response failed: {}, status: {}, body: {}",
            e, status, body
        )
    })?;

    if let Some(error_code) = &ocr_response.error_code {
        if error_code != "0" {
            return Err(format!(
                "[ocr_detect_online] Youdao error {}: {}",
                error_code,
                youdao_error_message(error_code)
            ));
        }
    }

    let mut text_blocks = Vec::new();
    if let Some(result) = &ocr_response.result {
        for region in &result.regions {
            for line in &region.lines {
                let Some(box_points) = parse_youdao_bounding_box(&line.bounding_box) else {
                    continue;
                };

                text_blocks.push(TextBlock {
                    box_points,
                    box_score: 1.0,
                    angle_index: 0,
                    angle_score: 0.0,
                    text: line.text.clone(),
                    text_score: 1.0,
                });
            }
        }
    }

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|e| format!("[ocr_detect_online] Failed to create hmac: {}", e))?;
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

async fn detect_with_tencent(
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
        .strip_prefix(TENCENT_SERVICE_TYPE_PREFIX)
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
