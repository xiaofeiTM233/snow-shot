use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use paddle_ocr_rs::ocr_result::TextBlock;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{TranslateTextResult, TranslationConfig, YOUDAO_LLM_SERVICE_TYPE};
use crate::common::{build_http_client, normalize_error_code, parse_number_list};
use crate::ocr::rect_to_box_points;
use crate::ocr::{prepare_image_bytes, OnlineOcrConfig};
use snow_shot_app_services::ocr_service::OcrDetectResult;

const YOUDAO_TEXT_ENDPOINT: &str = "https://openapi.youdao.com/api";
/// 批量文本翻译，支持一次传入多个 q
const YOUDAO_BATCH_TEXT_ENDPOINT: &str = "https://openapi.youdao.com/v2/api";
/// 大模型翻译，译文以 SSE 方式流式返回
const YOUDAO_LLM_TEXT_ENDPOINT: &str = "https://openapi.youdao.com/proxy/http/llm-trans";
const YOUDAO_IMAGE_TRANSLATION_ENDPOINT: &str = "https://openapi.youdao.com/ocrtransapi";
/// 有道图片翻译限制 base64 编码后不超过 5M
const YOUDAO_IMAGE_MAX_BASE64_LENGTH: usize = 5_000_000;
const YOUDAO_IMAGE_MAX_SIDE: u32 = 4096;

pub(super) async fn translate_text(
    config: &TranslationConfig,
    texts: Vec<String>,
    from: String,
    to: String,
    domain: String,
) -> Result<TranslateTextResult, String> {
    // 凭据去除首尾空白，避免复制粘贴引入空格导致签名校验失败
    let app_key = config.app_key.trim();
    let app_secret = config.app_secret.trim();
    if app_key.is_empty() || app_secret.is_empty() {
        return Err("[translate_text_online] Youdao appKey or appSecret is empty".to_string());
    }

    let from = if from.is_empty() {
        "auto".to_string()
    } else {
        from
    };
    let to = if to.is_empty() {
        "auto".to_string()
    } else {
        to
    };

    let results = if config.service_type == YOUDAO_LLM_SERVICE_TYPE {
        let mut results = Vec::with_capacity(texts.len());
        for text in &texts {
            results.push(translate_text_llm_once(app_key, app_secret, text, &from, &to).await?);
        }
        results
    } else if texts.len() == 1 {
        vec![translate_text_once(app_key, app_secret, &texts[0], &from, &to, &domain).await?]
    } else {
        translate_text_batch(app_key, app_secret, &texts, &from, &to).await?
    };

    Ok(TranslateTextResult {
        results,
        from: None,
    })
}

fn current_unix_seconds() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|now| now.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

/// v3 签名的 input：q 长度大于 20 时为 q前10字符 + q长度 + q后10字符，否则为 q 本身
fn v3_sign_input(q: &str) -> String {
    let char_count = q.chars().count();
    if char_count > 20 {
        let head: String = q.chars().take(10).collect();
        let tail: String = q.chars().skip(char_count - 10).collect();
        format!("{}{}{}", head, char_count, tail)
    } else {
        q.to_string()
    }
}

/// signType=v3: sha256(应用ID + input + salt + curtime + 应用密钥)
fn sign_v3(app_key: &str, input: &str, salt: &str, curtime: &str, app_secret: &str) -> String {
    let raw = format!("{}{}{}{}{}", app_key, input, salt, curtime, app_secret);
    hex::encode(Sha256::digest(raw.as_bytes()))
}

/// 由请求内容生成盐值，配合 curtime 防重放
fn generate_salt(payload: &str) -> String {
    let digest = Sha256::digest(payload.as_bytes());
    hex::encode(digest)
}

#[derive(Deserialize)]
struct YoudaoTextResponse {
    #[serde(rename = "errorCode", default)]
    error_code: Option<serde_json::Value>,
    #[serde(default)]
    translation: Vec<String>,
}

/// 文本翻译（wbfy），单段文本
async fn translate_text_once(
    app_key: &str,
    app_secret: &str,
    text: &str,
    from: &str,
    to: &str,
    domain: &str,
) -> Result<String, String> {
    let curtime = current_unix_seconds();
    let salt = generate_salt(text);
    let sign = sign_v3(app_key, &v3_sign_input(text), &salt, &curtime, app_secret);

    let mut params = vec![
        ("q", text.to_string()),
        ("from", from.to_string()),
        ("to", to.to_string()),
        ("appKey", app_key.to_string()),
        ("salt", salt),
        ("sign", sign),
        ("signType", "v3".to_string()),
        ("curtime", curtime),
    ];
    // 领域化翻译仅在控制台开通后可用，默认通用领域不传
    if domain != "general" && !domain.is_empty() {
        params.push(("domain", domain.to_string()));
    }

    let client = build_http_client()?;
    let body = client
        .post(YOUDAO_TEXT_ENDPOINT)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("[translate_text_online] Youdao request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("[translate_text_online] Youdao read response failed: {}", e))?;

    let response: YoudaoTextResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[translate_text_online] Youdao parse response failed: {}, body: {}",
            e, body
        )
    })?;

    let error_code = normalize_error_code(&response.error_code);
    if !error_code.is_empty() && error_code != "0" {
        return Err(format!(
            "[translate_text_online] Youdao error code: {}",
            error_code
        ));
    }

    Ok(response.translation.join("\n"))
}

#[derive(Deserialize)]
struct YoudaoBatchTextResponse {
    #[serde(rename = "errorCode", default)]
    error_code: Option<serde_json::Value>,
    #[serde(default)]
    translate_results: Vec<YoudaoBatchTranslateResult>,
}

#[derive(Deserialize)]
struct YoudaoBatchTranslateResult {
    #[serde(default)]
    translation: String,
}

/// 批量文本翻译（plwbfy），一次请求翻译多段文本
async fn translate_text_batch(
    app_key: &str,
    app_secret: &str,
    texts: &[String],
    from: &str,
    to: &str,
) -> Result<Vec<String>, String> {
    // 签名 input 按所有 q 拼接后的字符串计算
    let joined = texts.join("");
    let curtime = current_unix_seconds();
    let salt = generate_salt(&joined);
    let sign = sign_v3(
        app_key,
        &v3_sign_input(&joined),
        &salt,
        &curtime,
        app_secret,
    );

    let mut params: Vec<(&str, String)> = texts.iter().map(|text| ("q", text.clone())).collect();
    params.extend([
        ("from", from.to_string()),
        ("to", to.to_string()),
        ("appKey", app_key.to_string()),
        ("salt", salt),
        ("sign", sign),
        ("signType", "v3".to_string()),
        ("curtime", curtime),
    ]);

    let client = build_http_client()?;
    let body = client
        .post(YOUDAO_BATCH_TEXT_ENDPOINT)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("[translate_text_online] Youdao request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("[translate_text_online] Youdao read response failed: {}", e))?;

    let response: YoudaoBatchTextResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[translate_text_online] Youdao parse response failed: {}, body: {}",
            e, body
        )
    })?;

    let error_code = normalize_error_code(&response.error_code);
    if !error_code.is_empty() && error_code != "0" {
        return Err(format!(
            "[translate_text_online] Youdao error code: {}",
            error_code
        ));
    }

    // 部分段落失败（errorIndex）时以原文兜底，保持与入参一一对应
    Ok(texts
        .iter()
        .enumerate()
        .map(|(index, text)| {
            response
                .translate_results
                .get(index)
                .map(|result| result.translation.clone())
                .unwrap_or_else(|| text.clone())
        })
        .collect())
}

#[derive(Deserialize)]
struct YoudaoLlmStreamEvent {
    #[serde(default)]
    code: Option<serde_json::Value>,
    #[serde(default)]
    message: String,
    #[serde(default)]
    successful: bool,
    #[serde(default)]
    data: Option<YoudaoLlmStreamData>,
}

#[derive(Deserialize)]
struct YoudaoLlmStreamData {
    #[serde(rename = "transFull", default)]
    trans_full: String,
}

/// 大模型翻译（dmxfy），单段文本，streamType=full 时最后一条消息携带完整译文
async fn translate_text_llm_once(
    app_key: &str,
    app_secret: &str,
    text: &str,
    from: &str,
    to: &str,
) -> Result<String, String> {
    let curtime = current_unix_seconds();
    let salt = generate_salt(text);
    let sign = sign_v3(app_key, &v3_sign_input(text), &salt, &curtime, app_secret);

    let params = [
        ("appKey", app_key.to_string()),
        ("salt", salt),
        ("curtime", curtime),
        ("sign", sign),
        ("signType", "v3".to_string()),
        ("i", text.to_string()),
        ("from", from.to_string()),
        ("to", to.to_string()),
        ("streamType", "full".to_string()),
    ];

    let client = build_http_client()?;
    let body = client
        .post(YOUDAO_LLM_TEXT_ENDPOINT)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("[translate_text_online] Youdao request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("[translate_text_online] Youdao read response failed: {}", e))?;

    let mut last_trans_full: Option<String> = None;
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 兼容标准 SSE 的 "data: {...}" 与裸 JSON 两种行格式
        let payload = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
        let Ok(event) = serde_json::from_str::<YoudaoLlmStreamEvent>(payload) else {
            continue;
        };

        if !event.successful {
            let code = normalize_error_code(&event.code);
            return Err(format!(
                "[translate_text_online] Youdao LLM error {}: {}",
                code, event.message
            ));
        }

        if let Some(data) = &event.data {
            if !data.trans_full.is_empty() {
                last_trans_full = Some(data.trans_full.clone());
            }
        }
    }

    last_trans_full.ok_or_else(|| {
        format!(
            "[translate_text_online] Youdao LLM empty response, body: {}",
            body
        )
    })
}

#[derive(Deserialize)]
struct YoudaoImageTranslationResponse {
    #[serde(rename = "errorCode", default)]
    error_code: Option<serde_json::Value>,
    #[serde(default)]
    res_regions: Vec<YoudaoImageRegion>,
}

#[derive(Deserialize)]
struct YoudaoImageRegion {
    #[serde(rename = "boundingBox", default)]
    bounding_box: String,
    #[serde(default)]
    tran_content: String,
}

/// 图片翻译（tpfy），结果按 OCR 接入商的方式返回
pub(crate) async fn translate_image_as_ocr(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<OcrDetectResult, String> {
    let app_key = config.app_key.trim();
    let app_secret = config.app_secret.trim();
    if app_key.is_empty() || app_secret.is_empty() {
        return Err("[ocr_detect_online] Youdao appKey or appSecret is empty".to_string());
    }

    let image_bytes =
        prepare_image_bytes(image, YOUDAO_IMAGE_MAX_SIDE, YOUDAO_IMAGE_MAX_BASE64_LENGTH)?;
    let image_base64 = BASE64_STANDARD.encode(&image_bytes);

    let from = if config.language.is_empty() {
        "auto"
    } else {
        &config.language
    };
    let to = if config.target_language.is_empty() {
        "zh-CHS"
    } else {
        &config.target_language
    };

    let curtime = current_unix_seconds();
    let salt = generate_salt(&image_base64);
    let sign = sign_v3(
        app_key,
        &v3_sign_input(&image_base64),
        &salt,
        &curtime,
        app_secret,
    );

    let params = [
        ("type", "1".to_string()),
        ("q", image_base64),
        ("from", from.to_string()),
        ("to", to.to_string()),
        ("appKey", app_key.to_string()),
        ("salt", salt),
        ("sign", sign),
        ("signType", "v3".to_string()),
        ("curtime", curtime),
        ("docType", "json".to_string()),
        ("render", "0".to_string()),
    ];

    let client = build_http_client()?;
    let body = client
        .post(YOUDAO_IMAGE_TRANSLATION_ENDPOINT)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("[ocr_detect_online] Youdao request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("[ocr_detect_online] Youdao read response failed: {}", e))?;

    let response: YoudaoImageTranslationResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Youdao parse response failed: {}, body: {}",
            e, body
        )
    })?;

    let error_code = normalize_error_code(&response.error_code);
    if !error_code.is_empty() && error_code != "0" {
        return Err(format!(
            "[ocr_detect_online] Youdao error code: {}",
            error_code
        ));
    }

    let text_blocks = response
        .res_regions
        .iter()
        .filter_map(|region| {
            let values = parse_number_list(&region.bounding_box);
            if values.len() < 4 {
                return None;
            }

            Some(TextBlock {
                box_points: rect_to_box_points(values[0], values[1], values[2], values[3]),
                box_score: 1.0,
                angle_index: 0,
                angle_score: 0.0,
                text: region.tran_content.clone(),
                text_score: 1.0,
            })
        })
        .collect();

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}
