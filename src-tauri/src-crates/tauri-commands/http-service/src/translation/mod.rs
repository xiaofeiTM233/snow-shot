pub(crate) mod aliyun;
pub(crate) mod baidu;
pub(crate) mod volcengine;
pub(crate) mod youdao;

use serde::{Deserialize, Serialize};

/// 有道 图片翻译（ocrtransapi），按 OCR 接入商方式使用
pub const YOUDAO_IMAGE_TRANSLATION_SERVICE_TYPE: &str = "youdao:imageTranslation";

/// 有道服务类型：文本翻译（单段走 wbfy、多段走 plwbfy 批量翻译）
pub const YOUDAO_TEXT_SERVICE_TYPE: &str = "youdao:text";
/// 有道服务类型：大模型翻译（dmxfy）
pub const YOUDAO_LLM_SERVICE_TYPE: &str = "youdao:llm";

/// 阿里云服务类型：机器翻译通用版（单段 TranslateGeneral、多段 GetBatchTranslate）
pub const ALIYUN_GENERAL_SERVICE_TYPE: &str = "aliyun:general";
/// 阿里云服务类型：机器翻译专业版（单段 Translate、多段 GetBatchTranslate）
pub const ALIYUN_PROFESSIONAL_SERVICE_TYPE: &str = "aliyun:professional";
/// 阿里云 图片翻译（TranslateImage），按 OCR 接入商方式使用
pub const ALIYUN_IMAGE_TRANSLATION_SERVICE_TYPE: &str = "aliyun:imageTranslation";

/// 火山引擎服务类型：文本翻译（TranslateText，TextList 天然批量）
pub const VOLC_TEXT_SERVICE_TYPE: &str = "volcengine:text";
/// 火山引擎 图片翻译（TranslateImage），按 OCR 接入商方式使用
pub const VOLC_IMAGE_TRANSLATION_SERVICE_TYPE: &str = "volcengine:imageTranslation";

/// 百度智能云服务类型：文本翻译（texttrans/v1，q 多行批量）
pub const BAIDU_TEXT_SERVICE_TYPE: &str = "baidu:text";
/// 百度智能云 图片翻译（pictrans/v1），按 OCR 接入商方式使用
pub const BAIDU_IMAGE_TRANSLATION_SERVICE_TYPE: &str = "baidu:imageTranslation";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationConfig {
    /// 服务类型，格式为 `provider:service`，例如 `youdao:text`、`aliyun:general`
    pub service_type: String,
    /// 有道 应用ID（appKey）
    #[serde(default)]
    pub app_key: String,
    /// 有道 应用密钥
    #[serde(default)]
    pub app_secret: String,
    /// 阿里云 / 火山引擎 AccessKeyId
    #[serde(default)]
    pub secret_id: String,
    /// 阿里云 / 火山引擎 AccessKeySecret
    #[serde(default)]
    pub secret_key: String,
    /// 火山引擎 地域（默认 cn-north-1）
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
    } else if config.service_type == ALIYUN_GENERAL_SERVICE_TYPE
        || config.service_type == ALIYUN_PROFESSIONAL_SERVICE_TYPE
    {
        aliyun::translate_text(&config, texts, from, to, domain).await
    } else if config.service_type == VOLC_TEXT_SERVICE_TYPE {
        volcengine::translate_text(&config, texts, from, to).await
    } else if config.service_type == BAIDU_TEXT_SERVICE_TYPE {
        baidu::translate_text(&config, texts, from, to).await
    } else {
        Err(format!(
            "[translate_text_online] Unknown service type: {}",
            config.service_type
        ))
    }
}
