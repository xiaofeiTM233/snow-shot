use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Deserialize;

use super::{TranslateTextResult, TranslationConfig, ALIYUN_PROFESSIONAL_SERVICE_TYPE};
use crate::common::{build_http_client, hmac_sha256, sha256_hex, utc_datetime_from_unix};
use crate::ocr::rect_to_box_points;
use crate::ocr::{prepare_image_bytes, OnlineOcrConfig};
use snow_shot_app_services::ocr_service::{OcrDetectResult, TextBlock};

const ALIYUN_MT_ENDPOINT: &str = "https://mt.aliyuncs.com/";
const ALIYUN_MT_HOST: &str = "mt.aliyuncs.com";
const ALIYUN_MT_VERSION: &str = "2018-10-12";
/// 阿里云批量翻译单次最多 50 条，单条最长 1000 字符
const ALIYUN_BATCH_MAX_ITEMS: usize = 50;
const ALIYUN_BATCH_MAX_ITEM_CHARS: usize = 1000;
/// 图片翻译 base64 后限制 10M
const ALIYUN_IMAGE_MAX_BASE64_LENGTH: usize = 10_000_000;
const ALIYUN_IMAGE_MAX_SIDE: u32 = 8192;

pub(super) async fn translate_text(
    config: &TranslationConfig,
    texts: Vec<String>,
    from: String,
    to: String,
    domain: String,
) -> Result<TranslateTextResult, String> {
    // 凭据去除首尾空白，避免复制粘贴引入空格导致签名校验失败
    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err("[translate_text_online] Aliyun AccessKeyId or AccessKeySecret is empty".to_string());
    }

    let professional = config.service_type == ALIYUN_PROFESSIONAL_SERVICE_TYPE;
    let source = map_language_code(&from);
    let target = map_language_code(&to);
    // 通用版场景固定 general；专业版按应用翻译领域映射（ computers/game 无对应场景，回退 social）
    let scene = if professional {
        professional_scene(&domain).to_string()
    } else {
        "general".to_string()
    };

    let mut results: Vec<String> = vec![String::new(); texts.len()];
    // 适配批量接口的段落与需单独调用（超长段落）的段落
    let mut batch_items: Vec<(usize, String)> = Vec::new();
    for (index, text) in texts.iter().enumerate() {
        if text.chars().count() <= ALIYUN_BATCH_MAX_ITEM_CHARS {
            batch_items.push((index, text.clone()));
        } else {
            results[index] =
                translate_single(secret_id, secret_key, professional, &scene, text, &source, &target).await?;
        }
    }

    for chunk in batch_items.chunks(ALIYUN_BATCH_MAX_ITEMS) {
        let chunk_results =
            translate_batch(secret_id, secret_key, professional, &scene, chunk, &source, &target).await?;
        for ((index, original), translated) in chunk.iter().zip(chunk_results) {
            // 单段翻译失败（code != 200）时以原文兜底
            results[*index] = translated.unwrap_or_else(|| original.clone());
        }
    }

    Ok(TranslateTextResult { results, from: None })
}

fn map_language_code(lang: &str) -> String {
    match lang {
        "zh-CHS" => "zh".to_string(),
        "zh-CHT" => "zh-tw".to_string(),
        "" | "auto" => "auto".to_string(),
        other => other.to_string(),
    }
}

/// 专业版场景映射，支持 title/description/communication/medical/social/finance
fn professional_scene(domain: &str) -> &'static str {
    match domain {
        "medicine" => "medical",
        "finance" => "finance",
        _ => "social",
    }
}

/// 阿里云 ACS3-HMAC-SHA256 签名（RPC 风格，业务参数走 form body，Action/Version 放 header）
async fn post_mt_api(
    secret_id: &str,
    secret_key: &str,
    action: &str,
    body: String,
) -> Result<String, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("[translate_text_online] Failed to get current time: {}", e))?;
    let timestamp = now.as_secs();
    let x_acs_date = utc_datetime_from_unix(timestamp);
    // 防重放随机串，由请求内容派生
    let nonce = sha256_hex(format!("{}{}", body, timestamp).as_bytes());

    // 按头名排序后的规范头
    let signed_headers = "content-type;host;x-acs-action;x-acs-date;x-acs-signature-nonce;x-acs-version";
    let canonical_headers = format!(
        "content-type:application/x-www-form-urlencoded; charset=utf-8\nhost:{}\nx-acs-action:{}\nx-acs-date:{}\nx-acs-signature-nonce:{}\nx-acs-version:{}\n",
        ALIYUN_MT_HOST, action, x_acs_date, nonce, ALIYUN_MT_VERSION
    );
    let canonical_request = format!(
        "POST\n/\n\n{}\n{}\n{}",
        canonical_headers,
        signed_headers,
        sha256_hex(body.as_bytes())
    );
    let string_to_sign = format!("ACS3-HMAC-SHA256\n{}", sha256_hex(canonical_request.as_bytes()));
    let signature = hex::encode(hmac_sha256(secret_key.as_bytes(), string_to_sign.as_bytes())?);

    let authorization = format!(
        "ACS3-HMAC-SHA256 Credential={}, SignedHeaders={}, Signature={}",
        secret_id, signed_headers, signature
    );

    let client = build_http_client()?;
    let response = client
        .post(ALIYUN_MT_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
        .header("X-ACS-Action", action)
        .header("X-ACS-Date", &x_acs_date)
        .header("X-ACS-Signature-Nonce", nonce)
        .header("X-ACS-Version", ALIYUN_MT_VERSION)
        .header("Authorization", authorization)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("[translate_text_online] Aliyun request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("[translate_text_online] Aliyun read response failed: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "[translate_text_online] Aliyun error (HTTP {}): {}",
            status, body
        ));
    }

    Ok(body)
}

#[derive(Deserialize)]
struct AliyunMtResponse {
    #[serde(default)]
    data: Option<AliyunMtData>,
}

#[derive(Deserialize)]
struct AliyunMtData {
    #[serde(rename = "Translated", default)]
    translated: String,
    #[serde(rename = "DetectedLanguage", default)]
    detected_language: String,
}

/// 单段翻译：通用版 TranslateGeneral / 专业版 Translate
async fn translate_single(
    secret_id: &str,
    secret_key: &str,
    professional: bool,
    scene: &str,
    text: &str,
    source: &str,
    target: &str,
) -> Result<String, String> {
    let action = if professional { "Translate" } else { "TranslateGeneral" };
    let body = format!(
        "FormatType=text&Scene={scene}&SourceLanguage={source}&SourceText={text}&TargetLanguage={target}",
        scene = urlencode(scene),
        source = urlencode(source),
        text = urlencode(text),
        target = urlencode(target),
    );

    let body = post_mt_api(secret_id, secret_key, action, body).await?;
    let response: AliyunMtResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[translate_text_online] Aliyun parse response failed: {}, body: {}",
            e, body
        )
    })?;

    response
        .data
        .map(|data| data.translated)
        .ok_or_else(|| format!("[translate_text_online] Aliyun empty response, body: {}", body))
}

#[derive(Deserialize)]
struct AliyunBatchResponse {
    #[serde(default)]
    data: Option<AliyunBatchData>,
}

#[derive(Deserialize)]
struct AliyunBatchData {
    #[serde(rename = "TranslatedList", default)]
    translated_list: Vec<AliyunBatchItem>,
}

#[derive(Deserialize)]
struct AliyunBatchItem {
    #[serde(rename = "code", default)]
    code: String,
    #[serde(rename = "index", default)]
    index: String,
    #[serde(rename = "translated", default)]
    translated: String,
}

/// 批量翻译：GetBatchTranslate，ApiType 区分通用/专业版；返回与入参块对应的译文（None 表示该段失败）
async fn translate_batch(
    secret_id: &str,
    secret_key: &str,
    professional: bool,
    scene: &str,
    items: &[(usize, String)],
    source: &str,
    target: &str,
) -> Result<Vec<Option<String>>, String> {
    // SourceText 为 JSON 对象：key 为唯一标记（用位置序号），value 为待翻译内容
    let source_map: serde_json::Map<String, serde_json::Value> = items
        .iter()
        .enumerate()
        .map(|(key, (_, text))| (key.to_string(), serde_json::Value::String(text.clone())))
        .collect();
    let source_text = serde_json::Value::Object(source_map).to_string();
    let api_type = if professional {
        "translate_ecommerce"
    } else {
        "translate_standard"
    };

    let body = format!(
        "ApiType={api_type}&FormatType=text&Scene={scene}&SourceLanguage={source}&SourceText={source_text}&TargetLanguage={target}",
        api_type = api_type,
        scene = urlencode(scene),
        source = urlencode(source),
        source_text = urlencode(&source_text),
        target = urlencode(target),
    );

    let body = post_mt_api(secret_id, secret_key, "GetBatchTranslate", body).await?;
    let response: AliyunBatchResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[translate_text_online] Aliyun parse response failed: {}, body: {}",
            e, body
        )
    })?;

    let translated_list = response
        .data
        .map(|data| data.translated_list)
        .unwrap_or_default();

    let mut results: Vec<Option<String>> = vec![None; items.len()];
    for item in translated_list {
        // index 与请求中的 key 对应；code 非 200 表示该段翻译失败
        if item.code != "200" {
            continue;
        }
        let Ok(index) = item.index.parse::<usize>() else {
            continue;
        };
        if let Some(slot) = results.get_mut(index) {
            *slot = Some(item.translated);
        }
    }

    Ok(results)
}

fn urlencode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char)
            }
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

#[derive(Deserialize)]
struct AliyunImageResponse {
    #[serde(rename = "Code", default)]
    code: Option<serde_json::Value>,
    #[serde(rename = "Message", default)]
    message: String,
    #[serde(rename = "Data", default)]
    data: Option<AliyunImageData>,
}

#[derive(Deserialize)]
struct AliyunImageData {
    /// 译后编辑器渲染数据（JSON 字符串），内含文本块坐标与译文
    #[serde(rename = "TemplateJson", default)]
    template_json: String,
}

/// 从编辑器模板 JSON 中递归收集 type=text 的节点
fn collect_text_nodes(node: &serde_json::Value, nodes: &mut Vec<serde_json::Value>) {
    match node {
        serde_json::Value::Object(map) => {
            if map.get("type").and_then(|v| v.as_str()) == Some("text") {
                nodes.push(node.clone());
            }
            if let Some(children) = map.get("children").and_then(|v| v.as_array()) {
                for child in children {
                    collect_text_nodes(child, nodes);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_text_nodes(item, nodes);
            }
        }
        _ => {}
    }
}

/// 图片翻译（TranslateImage），结果按 OCR 接入商的方式返回
pub(crate) async fn translate_image_as_ocr(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<OcrDetectResult, String> {
    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err("[ocr_detect_online] Aliyun AccessKeyId or AccessKeySecret is empty".to_string());
    }

    let image_bytes = prepare_image_bytes(image, ALIYUN_IMAGE_MAX_SIDE, ALIYUN_IMAGE_MAX_BASE64_LENGTH)?;
    let image_base64 = BASE64_STANDARD.encode(&image_bytes);

    let source = if config.language.is_empty() {
        "auto".to_string()
    } else {
        map_language_code(&config.language)
    };
    let target = if config.target_language.is_empty() {
        "zh".to_string()
    } else {
        map_language_code(&config.target_language)
    };

    let ext = serde_json::json!({ "needEditorData": "true" }).to_string();
    let body = format!(
        "Ext={ext}&ImageBase64={image_base64}&SourceLanguage={source}&TargetLanguage={target}",
        ext = urlencode(&ext),
        image_base64 = urlencode(&image_base64),
        source = urlencode(&source),
        target = urlencode(&target),
    );

    let body = post_mt_api(secret_id, secret_key, "TranslateImage", body).await?;
    let response: AliyunImageResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Aliyun parse response failed: {}, body: {}",
            e, body
        )
    })?;

    // 失败时 Code 为字符串错误码（成功时为数字 200）
    if let Some(code) = &response.code {
        if !code.is_null() && code.as_i64() != Some(200) {
            return Err(format!(
                "[ocr_detect_online] Aliyun error: {} ({})",
                code, response.message
            ));
        }
    }

    let data = response
        .data
        .ok_or("[ocr_detect_online] Aliyun empty response")?;
    if data.template_json.is_empty() {
        return Err("[ocr_detect_online] Aliyun image translation returned no editor data".to_string());
    }

    let template: serde_json::Value = serde_json::from_str(&data.template_json).map_err(|e| {
        format!(
            "[ocr_detect_online] Aliyun parse TemplateJson failed: {}",
            e
        )
    })?;

    let mut text_nodes = Vec::new();
    collect_text_nodes(&template, &mut text_nodes);
    if text_nodes.is_empty() {
        return Err("[ocr_detect_online] Aliyun image translation found no text".to_string());
    }

    let text_blocks = text_nodes
        .iter()
        .filter_map(|node| {
            let map = node.as_object()?;
            let left = map.get("left")?.as_f64()?;
            let top = map.get("top")?.as_f64()?;
            let width = map.get("width")?.as_f64()?;
            let height = map.get("height")?.as_f64()?;
            let content = map.get("content")?.as_str()?;
            if content.is_empty() {
                return None;
            }

            Some(TextBlock {
                box_points: rect_to_box_points(left, top, width, height),
                box_score: 1.0,
                angle_index: 0,
                angle_score: 0.0,
                text: content.to_string(),
                text_score: 1.0,
            })
        })
        .collect::<Vec<TextBlock>>();

    if text_blocks.is_empty() {
        return Err("[ocr_detect_online] Aliyun image translation found no text".to_string());
    }

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}
