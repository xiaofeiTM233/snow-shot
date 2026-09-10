pub(crate) mod tencent;
pub(crate) mod youdao;

use serde::{Deserialize, Serialize};

/// 有道 图片翻译（ocrtransapi），按 OCR 接入商方式使用
pub const YOUDAO_IMAGE_TRANSLATION_SERVICE_TYPE: &str = "youdao:imageTranslation";
/// 腾讯云 端到端图片翻译（ImageTranslateLLM），按 OCR 接入商方式使用
pub const TENCENT_IMAGE_TRANSLATE_LLM_SERVICE_TYPE: &str = "tencent:imageTranslateLLM";

/// 有道服务类型：文本翻译（单段走 wbfy、多段走 plwbfy 批量翻译）
pub const YOUDAO_TEXT_SERVICE_TYPE: &str = "youdao:text";
/// 有道服务类型：大模型翻译（dmxfy）
pub const YOUDAO_LLM_SERVICE_TYPE: &str = "youdao:llm";
/// 腾讯云服务类型：文本翻译（TextTranslate）
pub const TENCENT_TEXT_SERVICE_TYPE: &str = "tencent:text";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationConfig {
    /// 服务类型，格式为 `provider:service`，例如 `youdao:text`、`tencent:text`
    pub service_type: String,
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

#[derive(Debug, Serialize, Deserialize)]
pub struct TranslateTextResult {
    /// 与入参 texts 顺序对应的翻译结果
    pub results: Vec<String>,
    /// 服务检测到的源语言（部分服务支持）
    #[serde(default)]
    pub from: Option<String>,
}

pub async fn translate_text(
    config: TranslationConfig,
    texts: Vec<String>,
    from: String,
    to: String,
    domain: String,
) -> Result<TranslateTextResult, String> {
    if texts.is_empty() {
        return Ok(TranslateTextResult {
            results: Vec::new(),
            from: None,
        });
    }

    if config.service_type == YOUDAO_TEXT_SERVICE_TYPE
        || config.service_type == YOUDAO_LLM_SERVICE_TYPE
    {
        youdao::translate_text(&config, texts, from, to, domain).await
    } else if config.service_type == TENCENT_TEXT_SERVICE_TYPE {
        tencent::translate_text(&config, texts, from, to).await
    } else {
        Err(format!(
            "[translate_text_online] Unknown service type: {}",
            config.service_type
        ))
    }
}
