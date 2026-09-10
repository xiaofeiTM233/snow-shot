use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use paddle_ocr_rs::ocr_result::TextBlock;
use serde::Deserialize;

use super::prepare_image_bytes;
use super::rect_to_box_points;
use super::OnlineOcrConfig;
use crate::common::build_http_client;
use crate::common::normalize_error_code;
use snow_shot_app_services::ocr_service::OcrDetectResult;

const BAIDU_TOKEN_ENDPOINT: &str = "https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_OCR_ENDPOINT: &str = "https://aip.baidubce.com/rest/2.0/ocr/v1";
const BAIDU_MAX_IMAGE_SIDE: u32 = 8192;
const BAIDU_MAX_BASE64_LENGTH: usize = 8_000_000;

#[derive(Deserialize)]
struct BaiduTokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct BaiduOcrResponse {
    #[serde(default)]
    words_result: Vec<BaiduWordInfo>,
    #[serde(default)]
    error_code: Option<serde_json::Value>,
    #[serde(default)]
    error_msg: Option<String>,
}

#[derive(Deserialize)]
struct BaiduWordInfo {
    #[serde(default)]
    words: String,
    #[serde(default)]
    location: Option<BaiduLocation>,
}

#[derive(Deserialize)]
struct BaiduLocation {
    #[serde(default)]
    left: f64,
    #[serde(default)]
    top: f64,
    #[serde(default)]
    width: f64,
    #[serde(default)]
    height: f64,
}

pub(super) async fn detect_with_baidu(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
    detect_angle: bool,
) -> Result<OcrDetectResult, String> {
    // 凭据去除首尾空白，避免复制粘贴引入空格导致鉴权失败
    let api_key = config.api_key.trim();
    let secret_key = config.secret_key.trim();
    if api_key.is_empty() || secret_key.is_empty() {
        return Err("[ocr_detect_online] Baidu API Key or Secret Key is empty".to_string());
    }

    let action = config
        .service_type
        .strip_prefix(super::BAIDU_SERVICE_TYPE_PREFIX)
        .unwrap_or("GeneralBasic");
    let path = match action {
        "GeneralAccurateBasic" => "accurate_basic",
        _ => "general_basic",
    };

    let client = build_http_client()?;

    // 通过 API Key / Secret Key 换取 access_token
    let token_response: BaiduTokenResponse = client
        .get(BAIDU_TOKEN_ENDPOINT)
        .query(&[
            ("grant_type", "client_credentials"),
            ("client_id", api_key),
            ("client_secret", secret_key),
        ])
        .send()
        .await
        .map_err(|e| format!("[ocr_detect_online] Baidu token request failed: {}", e))?
        .json()
        .await
        .map_err(|e| {
            format!(
                "[ocr_detect_online] Baidu parse token response failed: {}",
                e
            )
        })?;

    let Some(access_token) = token_response.access_token else {
        return Err(format!(
            "[ocr_detect_online] Baidu token error {}: {}",
            token_response.error.unwrap_or_default(),
            token_response.error_description.unwrap_or_default()
        ));
    };

    let image_bytes = prepare_image_bytes(image, BAIDU_MAX_IMAGE_SIDE, BAIDU_MAX_BASE64_LENGTH)?;
    let img_base64 = BASE64_STANDARD.encode(&image_bytes);

    // 默认中英混合（文档默认值），其余语言由配置指定
    let language_type = if config.language.is_empty() || config.language == "auto" {
        "CHN_ENG"
    } else {
        config.language.as_str()
    };

    let response = client
        .post(format!("{}/{}", BAIDU_OCR_ENDPOINT, path))
        .query(&[("access_token", access_token.as_str())])
        .form(&[
            ("image", img_base64.as_str()),
            ("language_type", language_type),
            (
                "detect_direction",
                if detect_angle { "true" } else { "false" },
            ),
        ])
        .send()
        .await
        .map_err(|e| format!("[ocr_detect_online] Baidu request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("[ocr_detect_online] Baidu read response failed: {}", e))?;

    let ocr_response: BaiduOcrResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[ocr_detect_online] Baidu parse response failed: {}, status: {}, body: {}",
            e, status, body
        )
    })?;

    let error_code = normalize_error_code(&ocr_response.error_code);
    if !error_code.is_empty() {
        return Err(format!(
            "[ocr_detect_online] Baidu error {}: {}",
            error_code,
            ocr_response.error_msg.unwrap_or_default()
        ));
    }

    let mut text_blocks = Vec::new();
    for word_info in &ocr_response.words_result {
        let box_points = word_info
            .location
            .as_ref()
            .map(|location| {
                rect_to_box_points(location.left, location.top, location.width, location.height)
            })
            .unwrap_or_default();

        text_blocks.push(TextBlock {
            box_points,
            box_score: 1.0,
            angle_index: 0,
            angle_score: 0.0,
            text: word_info.words.clone(),
            text_score: 1.0,
        });
    }

    Ok(OcrDetectResult {
        text_blocks,
        scale_factor: 1.0,
    })
}
