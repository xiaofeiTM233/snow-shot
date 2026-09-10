use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::ocr_line_to_text_block;
use super::prepare_image_bytes;
use super::OnlineOcrConfig;
use crate::common::build_http_client;
use crate::common::normalize_error_code;
use snow_shot_app_services::ocr_service::OcrDetectResult;

const YOUDAO_OCR_ENDPOINT: &str = "https://openapi.youdao.com/ocrapi";
const YOUDAO_MAX_IMAGE_SIDE: u32 = 2048;
/// 有道限制 base64 编码后小于 2M
const YOUDAO_MAX_BASE64_LENGTH: usize = 2_000_000;

#[derive(Deserialize)]
struct YoudaoOcrResponse {
    #[serde(rename = "errorCode", default)]
    error_code: Option<serde_json::Value>,
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
    lines: Vec<super::OcrLine>,
}

pub(super) async fn detect_with_youdao(
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

    let error_code = normalize_error_code(&ocr_response.error_code);
    if !error_code.is_empty() && error_code != "0" {
        return Err(format!(
            "[ocr_detect_online] Youdao error {}: {}",
            error_code,
            youdao_error_message(&error_code)
        ));
    }

    let mut text_blocks = Vec::new();
    if let Some(result) = &ocr_response.result {
        for region in &result.regions {
            for line in &region.lines {
                if let Some(block) = ocr_line_to_text_block(line) {
                    text_blocks.push(block);
                }
            }
        }
    }

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
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
