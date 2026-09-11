use serde::Deserialize;

use super::{TranslateTextResult, TranslationConfig};
use crate::common::build_http_client;
use crate::ocr::prepare_image_bytes;
use crate::ocr::OnlineOcrConfig;
use snow_shot_app_services::ocr_service::{OcrDetectResult, TextBlock};

const BAIDU_TOKEN_ENDPOINT: &str = "https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_TEXT_ENDPOINT: &str = "https://aip.baidubce.com/rpc/2.0/mt/texttrans/v1";
const BAIDU_IMAGE_ENDPOINT: &str = "https://aip.baidubce.com/file/2.0/mt/pictrans/v1";
/// 图片翻译限制 4M，最长边 4096
const BAIDU_IMAGE_MAX_BASE64_LENGTH: usize = 5_000_000;
const BAIDU_IMAGE_MAX_SIDE: u32 = 4096;

pub(super) async fn translate_text(
    config: &TranslationConfig,
    texts: Vec<String>,
    from: String,
    to: String,
) -> Result<TranslateTextResult, String> {
    // 凭据去除首尾空白，避免复制粘贴引入空格导致鉴权失败
    let api_key = config.app_key.trim();
    let secret_key = config.app_secret.trim();
    if api_key.is_empty() || secret_key.is_empty() {
        return Err("[translate_text_online] Baidu API Key or Secret Key is empty".to_string());
    }

    let access_token = get_access_token(api_key, secret_key).await?;
    let source = map_language_code(&from);
    let target = map_target_language(&to);

    // q 支持换行分隔的多行文本，响应 trans_result 逐行对应，天然批量
    let q = texts
        .iter()
        .map(|text| text.replace('\n', " "))
        .collect::<Vec<String>>()
        .join("\n");

    let payload = serde_json::json!({
        "q": q,
        "from": source,
        "to": target,
    })
    .to_string();

    let client = build_http_client()?;
    let body = client
        .post(BAIDU_TEXT_ENDPOINT)
        .query(&[("access_token", access_token.as_str())])
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|e| format!("[translate_text_online] Baidu request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("[translate_text_online] Baidu read response failed: {}", e))?;

    let response: BaiduTextResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[translate_text_online] Baidu parse response failed: {}, body: {}",
            e, body
        )
    })?;

    if let Some(error_code) = &response.error_code {
        return Err(format!(
            "[translate_text_online] Baidu error {}: {}",
            error_code,
            response.error_msg.unwrap_or_default()
        ));
    }

    // 个别行翻译失败或被合并时以原文兜底，保持与入参一一对应
    let results = texts
        .iter()
        .enumerate()
        .map(|(index, text)| {
            response
                .trans_result
                .as_ref()
                .and_then(|items| items.get(index))
                .map(|item| item.dst.clone())
                .unwrap_or_else(|| text.clone())
        })
        .collect();

    Ok(TranslateTextResult {
        results,
        from: response.from,
    })
}

/// 通过 API Key / Secret Key 获取 access_token（有效期 30 天，每次调用前拉取）
async fn get_access_token(api_key: &str, secret_key: &str) -> Result<String, String> {
    let client = build_http_client()?;
    let body: BaiduTokenResponse = client
        .post(BAIDU_TOKEN_ENDPOINT)
        .query(&[
            ("grant_type", "client_credentials"),
            ("client_id", api_key),
            ("client_secret", secret_key),
        ])
        .send()
        .await
        .map_err(|e| format!("[translate_text_online] Baidu token request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("[translate_text_online] Baidu token parse failed: {}", e))?;

    match body.access_token {
        Some(token) => Ok(token),
        None => Err(format!(
            "[translate_text_online] Baidu token error: {} ({})",
            body.error.unwrap_or_default(),
            body.error_description.unwrap_or_default()
        )),
    }
}

#[derive(Deserialize)]
struct BaiduTokenResponse {
    #[serde(rename = "access_token", default)]
    access_token: Option<String>,
    #[serde(rename = "error", default)]
    error: Option<String>,
    #[serde(rename = "error_description", default)]
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct BaiduTextResponse {
    #[serde(rename = "from", default)]
    from: Option<String>,
    #[serde(rename = "trans_result", default)]
    trans_result: Option<Vec<BaiduTransResult>>,
    #[serde(rename = "error_code", default)]
    error_code: Option<String>,
    #[serde(rename = "error_msg", default)]
    error_msg: Option<String>,
}

#[derive(Deserialize)]
struct BaiduTransResult {
    #[serde(rename = "src", default)]
    _src: String,
    #[serde(rename = "dst", default)]
    dst: String,
}

/// 应用语言代码 → 百度智能云翻译语言代码
fn map_language_code(lang: &str) -> String {
    match lang {
        "zh-CHS" | "" | "auto" => "auto".to_string(),
        "zh-CHT" => "cht".to_string(),
        "ja" => "jp".to_string(),
        "ko" => "kor".to_string(),
        "fr" => "fra".to_string(),
        "es" => "spa".to_string(),
        "ms" => "may".to_string(),
        other => other.to_string(),
    }
}

/// 图片翻译目标语言不支持 auto
fn map_target_language(lang: &str) -> String {
    match lang {
        "" | "auto" | "zh-CHS" => "zh".to_string(),
        "zh-CHT" => "cht".to_string(),
        "ja" => "jp".to_string(),
        "ko" => "kor".to_string(),
        "fr" => "fra".to_string(),
        "es" => "spa".to_string(),
        "ms" => "may".to_string(),
        other => other.to_string(),
    }
}

#[derive(Deserialize)]
struct BaiduImageResponse {
    #[serde(rename = "error_code", default)]
    error_code: Option<serde_json::Value>,
    #[serde(rename = "error_msg", default)]
    error_msg: Option<String>,
    #[serde(rename = "data", default)]
    data: Option<BaiduImageData>,
}

#[derive(Deserialize)]
struct BaiduImageData {
    #[serde(rename = "from", default)]
    from: Option<String>,
    #[serde(rename = "content", default)]
    content: Vec<BaiduImageContent>,
}

#[derive(Deserialize)]
struct BaiduImageContent {
    #[serde(rename = "dst", default)]
    dst: String,
    /// 译文贴合矩形四角点，坐标顺序：左上、右上、右下、左下
    #[serde(rename = "points", default)]
    points: Vec<BaiduImagePoint>,
}

#[derive(Deserialize)]
struct BaiduImagePoint {
    #[serde(rename = "x", default)]
    x: f64,
    #[serde(rename = "y", default)]
    y: f64,
}

/// 图片翻译（pictrans/v1），结果按 OCR 接入商的方式返回
pub(crate) async fn translate_image_as_ocr(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<OcrDetectResult, String> {
    let api_key = config.api_key.trim();
    let secret_key = config.secret_key.trim();
    if api_key.is_empty() || secret_key.is_empty() {
        return Err("[ocr_detect_online] Baidu API Key or Secret Key is empty".to_string());
    }

    let access_token = get_access_token(api_key, secret_key).await?;

    let image_bytes = prepare_image_bytes(image, BAIDU_IMAGE_MAX_SIDE, BAIDU_IMAGE_MAX_BASE64_LENGTH)?;
    let source = if config.language.is_empty() {
        "auto"
    } else {
        &config.language
    };
    let target = if config.target_language.is_empty() {
        "zh".to_string()
    } else {
        map_target_language(&config.target_language)
    };

    // v 固定为 3；paste=0 关闭文字贴合，仅取分段翻译内容与坐标
    let image_part = reqwest::multipart::Part::bytes(image_bytes)
        .file_name("image.png")
        .mime_str("image/png")
        .map_err(|e| format!("[ocr_detect_online] Baidu build multipart failed: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .part("image", image_part)
        .text("from", source.to_string())
        .text("to", target)
        .text("v", "3");

    let client = build_http_client()?;
    let body = client
        .post(BAIDU_IMAGE_ENDPOINT)
        .query(&[("access_token", access_token.as_str())])
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("[ocr_detect_online] Baidu request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("[ocr_detect_online] Baidu read response failed: {}", e))?;

    let response: BaiduImageResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Baidu parse response failed: {}, body: {}",
            e, body
        )
    })?;

    if let Some(error_code) = &response.error_code {
        // 响应中成功码可能为字符串 "0"
        let is_success = error_code.as_str() == Some("0")
            || error_code.as_i64() == Some(0);
        if !is_success {
            return Err(format!(
                "[ocr_detect_online] Baidu error {}: {}",
                error_code,
                response.error_msg.unwrap_or_default()
            ));
        }
    }

    let text_blocks = response
        .data
        .map(|data| {
            data.content
                .iter()
                .filter(|item| !item.dst.is_empty() && item.points.len() >= 3)
                .map(|item| TextBlock {
                    box_points: item
                        .points
                        .iter()
                        .map(|point| snow_shot_app_services::ocr_service::Point {
                            x: point.x.max(0.0) as u32,
                            y: point.y.max(0.0) as u32,
                        })
                        .collect(),
                    box_score: 1.0,
                    angle_index: 0,
                    angle_score: 0.0,
                    text: item.dst.clone(),
                    text_score: 1.0,
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}
