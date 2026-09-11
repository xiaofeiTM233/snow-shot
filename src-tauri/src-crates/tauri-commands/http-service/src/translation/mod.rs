pub(crate) mod youdao;

use serde::{Deserialize, Serialize};

/// 有道 图片翻译（ocrtransapi），按 OCR 接入商方式使用
pub const YOUDAO_IMAGE_TRANSLATION_SERVICE_TYPE: &str = "youdao:imageTranslation";

/// 有道服务类型：文本翻译（单段走 wbfy、多段走 plwbfy 批量翻译）
pub const YOUDAO_TEXT_SERVICE_TYPE: &str = "youdao:text";
/// 有道服务类型：大模型翻译（dmxfy）
pub const YOUDAO_LLM_SERVICE_TYPE: &str = "youdao:llm";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationConfig {
    /// 服务类型，格式为 `provider:service`，例如 `youdao:text`
    pub service_type: String,
    /// 有道 应用ID（appKey）
    #[serde(default)]
    pub app_key: String,
    /// 有道 应用密钥
    #[serde(default)]
    pub app_secret: String,
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
    } else {
        Err(format!(
            "[translate_text_online] Unknown service type: {}",
            config.service_type
        ))
    }
}
