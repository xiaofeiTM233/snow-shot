//! 在线服务适配器：在线 OCR、图片翻译、文本翻译
//!
//! 所有外部服务（有道、腾讯云、百度、阿里云、火山引擎、自定义）的适配逻辑都在本目录内，
//! 按厂商拆分文件；命令层统一通过本模块的三个入口调用：
//! - [`ocr_detect_online`]：在线文字识别（按 `service_type` 分发）
//! - [`translate_image`]：图片翻译（按 `provider` 分发）
//! - [`translate_text`]：文本翻译（按 `provider` 分发）

mod aliyun;
mod baidu;
mod custom;
mod tencent;
mod tencent_ocr;
mod tencent_translation;
mod volcengine;
mod youdao;
mod youdao_ocr;
mod youdao_translation;

use std::io::Cursor;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use hmac::{Hmac, Mac};
use paddle_ocr_rs::ocr_result::{Point, TextBlock};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use snow_shot_tauri_commands_ocr::OcrDetectResult;

pub(crate) const YOUDAO_SERVICE_TYPE_PREFIX: &str = "youdao:";
pub(crate) const TENCENT_SERVICE_TYPE_PREFIX: &str = "tencent:";
pub(crate) const BAIDU_SERVICE_TYPE_PREFIX: &str = "baidu:";
pub(crate) const ALIYUN_SERVICE_TYPE_PREFIX: &str = "aliyun:";
pub(crate) const VOLC_SERVICE_TYPE_PREFIX: &str = "volcengine:";
pub(crate) const CUSTOM_SERVICE_TYPE_PREFIX: &str = "custom:";

pub(crate) const YOUDAO_TRANSLATION_PROVIDER: &str = "youdao";
pub(crate) const TENCENT_TRANSLATION_PROVIDER: &str = "tencent";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineOcrConfig {
    /// 服务类型，格式为 `provider:service`，例如 `youdao:ocr`、`tencent:GeneralBasicOCR`
    pub service_type: String,
    /// 识别语言，取值跟随对应平台文档
    #[serde(default)]
    pub language: String,
    /// 自定义 API 地址
    #[serde(default)]
    pub api_uri: String,
    /// 百度 API Key
    #[serde(default)]
    pub api_key: String,
    /// 有道 应用ID（appKey）
    #[serde(default)]
    pub app_key: String,
    /// 有道 应用密钥
    #[serde(default)]
    pub app_secret: String,
    /// 腾讯云 SecretId / 阿里云 AccessKeyId / 火山引擎 AccessKeyId
    #[serde(default)]
    pub secret_id: String,
    /// 腾讯云 SecretKey / 阿里云 AccessKeySecret / 火山引擎 SecretAccessKey / 百度 Secret Key
    #[serde(default)]
    pub secret_key: String,
    /// 腾讯云 地域
    #[serde(default)]
    pub region: String,
}

/// 在线翻译配置，按 provider 提供对应凭据
#[derive(Debug, Clone, Deserialize)]
pub struct OnlineTranslationConfig {
    /// 服务提供方：`youdao` / `tencent`
    pub provider: String,
    /// 源语言（有道支持 auto；腾讯文本翻译不支持 auto，图片翻译自动识别源语言）
    #[serde(default)]
    pub from: String,
    /// 目标语言
    #[serde(default)]
    pub to: String,
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

/// 图片翻译结果中的一行（区域或行级）
#[derive(Debug, Clone, Serialize)]
pub struct MachineTranslatedImageLine {
    /// 原文
    pub source_text: String,
    /// 译文
    pub translated_text: String,
    /// 文本框（相对原图左上角）
    pub box_x: u32,
    pub box_y: u32,
    pub box_width: u32,
    pub box_height: u32,
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

    let image_data = request_raw_body(&request, "[ocr_detect_online]")?;

    let detect_angle = request
        .headers()
        .get("x-detect-angle")
        .and_then(|value| value.to_str().ok())
        .map(|value| value == "true")
        .unwrap_or(false);

    let image = image::load(Cursor::new(image_data), image::ImageFormat::Png)
        .map_err(|_| "[ocr_detect_online] Invalid image".to_string())?;

    if config.service_type.starts_with(YOUDAO_SERVICE_TYPE_PREFIX) {
        youdao_ocr::detect(&config, &image, detect_angle).await
    } else if config.service_type.starts_with(TENCENT_SERVICE_TYPE_PREFIX) {
        tencent_ocr::detect(&config, &image).await
    } else if config.service_type.starts_with(BAIDU_SERVICE_TYPE_PREFIX) {
        baidu::detect_with_baidu(&config, &image, detect_angle).await
    } else if config.service_type.starts_with(ALIYUN_SERVICE_TYPE_PREFIX) {
        aliyun::detect_with_aliyun(&config, &image).await
    } else if config.service_type.starts_with(VOLC_SERVICE_TYPE_PREFIX) {
        volcengine::detect_with_volc(&config, &image).await
    } else if config.service_type.starts_with(CUSTOM_SERVICE_TYPE_PREFIX) {
        custom::detect_with_custom(&config, &image).await
    } else {
        Err(format!(
            "[ocr_detect_online] Unknown service type: {}",
            config.service_type
        ))
    }
}

/// 图片翻译：整图提交，返回逐行原文、译文与文本框
pub async fn translate_image(
    request: tauri::ipc::Request<'_>,
) -> Result<Vec<MachineTranslatedImageLine>, String> {
    let config: OnlineTranslationConfig =
        parse_translation_config(&request, "[translate_image]")?;
    let image_data = request_raw_body(&request, "[translate_image]")?;

    match config.provider.as_str() {
        YOUDAO_TRANSLATION_PROVIDER => {
            youdao_translation::translate_image(&config, image_data).await
        }
        TENCENT_TRANSLATION_PROVIDER => {
            tencent_translation::translate_image(&config, image_data).await
        }
        other => Err(format!("[translate_image] Unknown provider: {}", other)),
    }
}

/// 文本翻译：请求体为 JSON 字符串数组
pub async fn translate_text(
    request: tauri::ipc::Request<'_>,
) -> Result<Vec<String>, String> {
    let config: OnlineTranslationConfig = parse_translation_config(&request, "[translate_text]")?;
    let body = request_raw_body(&request, "[translate_text]")?;
    let texts: Vec<String> = serde_json::from_slice(body)
        .map_err(|e| format!("[translate_text] Failed to parse request body: {}", e))?;

    match config.provider.as_str() {
        YOUDAO_TRANSLATION_PROVIDER => youdao_translation::translate_text(&config, texts).await,
        TENCENT_TRANSLATION_PROVIDER => {
            tencent_translation::translate_text(&config, texts).await
        }
        other => Err(format!("[translate_text] Unknown provider: {}", other)),
    }
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("[ocr_detect_online] Failed to build http client: {}", e))
}

fn now_unix_secs() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|e| format!("[ocr_detect_online] Failed to get current time: {}", e))
}

fn parse_translation_config<T: serde::de::DeserializeOwned>(
    request: &tauri::ipc::Request<'_>,
    context: &str,
) -> Result<T, String> {
    let config_header = request
        .headers()
        .get("x-translation-config")
        .ok_or(format!("[{}] Missing translation config header", context))?
        .to_str()
        .map_err(|_| format!("[{}] Invalid translation config header", context))?;
    let config_json = percent_decode_str(config_header)
        .decode_utf8()
        .map_err(|e| format!("[{}] Failed to decode translation config: {}", context, e))?;
    serde_json::from_str(&config_json)
        .map_err(|e| format!("[{}] Failed to parse translation config: {}", context, e))
}

fn request_raw_body<'r>(
    request: &'r tauri::ipc::Request<'_>,
    context: &str,
) -> Result<&'r [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => Ok(data.as_slice()),
        _ => Err(format!("[{}] Invalid request body", context)),
    }
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

/// 将矩形 (x, y, 宽, 高) 转为四个角点（左上/右上/右下/左下）
fn rect_to_box_points(x: f64, y: f64, width: f64, height: f64) -> Vec<Point> {
    vec![
        Point {
            x: clamp_to_u32(x),
            y: clamp_to_u32(y),
        },
        Point {
            x: clamp_to_u32(x + width),
            y: clamp_to_u32(y),
        },
        Point {
            x: clamp_to_u32(x + width),
            y: clamp_to_u32(y + height),
        },
        Point {
            x: clamp_to_u32(x),
            y: clamp_to_u32(y + height),
        },
    ]
}

/// 解析逗号分隔的数值串，例如 "8,2,717,30"
fn parse_number_list(value: &str) -> Vec<f64> {
    value
        .split(',')
        .filter_map(|item| item.trim().parse::<f64>().ok())
        .collect()
}

/// 解析有道系服务的 boundingBox 字符串为四个角点（左上/右上/右下/左下）：
/// 8 个数值时依次为 左上(x,y)、右上(x,y)、右下(x,y)、左下(x,y)，
/// 4 个数值时为 x,y,宽,高
fn parse_bounding_box(bounding_box: &str) -> Option<Vec<Point>> {
    let values = parse_number_list(bounding_box);
    match values.len() {
        len if len >= 8 => Some(
            values[..8]
                .chunks(2)
                .map(|chunk| Point {
                    x: clamp_to_u32(chunk[0]),
                    y: clamp_to_u32(chunk[1]),
                })
                .collect(),
        ),
        len if len >= 4 => {
            Some(rect_to_box_points(values[0], values[1], values[2], values[3]))
        }
        _ => None,
    }
}

/// 有道系服务（有道 OCR、自定义接口）共用的文本行结构，
/// words、lang、dir 等其余字段对识别结果无用，由 serde 自动忽略
#[derive(Deserialize)]
struct OcrLine {
    #[serde(rename = "boundingBox", default)]
    bounding_box: String,
    #[serde(rename = "verticesBoundingBox", default)]
    vertices_bounding_box: String,
    #[serde(default)]
    text: String,
}

/// 将有道系服务的文本行转换为 OCR 识别结果：
/// 优先使用 verticesBoundingBox（携带旋转信息），缺省时退回 boundingBox
fn ocr_line_to_text_block(line: &OcrLine) -> Option<TextBlock> {
    let box_points = if line.vertices_bounding_box.is_empty() {
        parse_bounding_box(&line.bounding_box)?
    } else {
        parse_bounding_box(&line.vertices_bounding_box)
            .or_else(|| parse_bounding_box(&line.bounding_box))?
    };

    Some(TextBlock {
        box_points,
        box_score: 1.0,
        angle_index: 0,
        angle_score: 0.0,
        text: line.text.clone(),
        text_score: 1.0,
    })
}

/// 将 errorCode 归一化为字符串（缺失或 null 返回空串），兼容字符串与数值两种形态
fn normalize_error_code(error_code: &Option<serde_json::Value>) -> String {
    match error_code {
        Some(serde_json::Value::String(value)) => value.clone(),
        Some(serde_json::Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|e| format!("[ocr_detect_online] Failed to create hmac: {}", e))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

/// 由 Unix 时间戳计算 UTC 日期（yyyy-MM-dd），用于 TC3 / V4 签名
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

/// 由 Unix 时间戳计算 UTC 日期时间（yyyy-MM-ddTHH:mm:ssZ），用于阿里云 V3 签名
fn utc_datetime_from_unix(timestamp: u64) -> String {
    let date = utc_date_from_unix(timestamp);
    let secs_of_day = timestamp % 86_400;
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        date,
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}
