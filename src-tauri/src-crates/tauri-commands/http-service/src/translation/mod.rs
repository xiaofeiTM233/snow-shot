//! 机器翻译命令：有道智云、腾讯云（文本翻译 + 图片翻译）
//!
//! 文本翻译命令直接透传参数；图片翻译命令从请求头解析配置、请求体读取图片，
//! 再分发到对应厂商的适配器。

mod tencent;
mod youdao;

use std::time::{SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use serde::de::DeserializeOwned;

pub use tencent::translate_text_tencent;
pub use youdao::translate_text_youdao;

/// 图片翻译结果中的一行（区域或行级）
#[derive(Debug, Clone, serde::Serialize)]
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

pub async fn translate_image_youdao(
    request: tauri::ipc::Request<'_>,
) -> Result<Vec<MachineTranslatedImageLine>, String> {
    let context = "[translate_image_youdao]";
    let config: youdao::YoudaoImageTranslateConfig =
        parse_translation_config(&request, context)?;
    let image_data = request_raw_body(&request, context)?;
    youdao::translate_image(config, image_data).await
}

pub async fn translate_image_tencent(
    request: tauri::ipc::Request<'_>,
) -> Result<Vec<MachineTranslatedImageLine>, String> {
    let context = "[translate_image_tencent]";
    let config: tencent::TencentImageTranslateConfig =
        parse_translation_config(&request, context)?;
    let image_data = request_raw_body(&request, context)?;
    tencent::translate_image(config, image_data).await
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Failed to build http client: {}", e))
}

fn now_unix_secs() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|e| format!("Failed to get current time: {}", e))
}

fn parse_translation_config<T: DeserializeOwned>(
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

fn clamp_to_u32(value: f64) -> u32 {
    if value.is_nan() || value <= 0.0 {
        0
    } else if value >= u32::MAX as f64 {
        u32::MAX
    } else {
        value as u32
    }
}
