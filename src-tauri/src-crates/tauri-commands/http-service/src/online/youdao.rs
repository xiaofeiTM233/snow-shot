//! 有道智云共享部分：v3 签名、错误码归一化、语言码

use sha2::{Digest, Sha256};

/// 有道文本翻译接口
pub(super) const YOUDAO_TEXT_TRANSLATE_ENDPOINT: &str = "https://openapi.youdao.com/v2/api";
/// 有道图片翻译接口
pub(super) const YOUDAO_IMAGE_TRANSLATE_ENDPOINT: &str = "https://openapi.youdao.com/ocrtransapi";
/// 有道 OCR 接口
pub(super) const YOUDAO_OCR_ENDPOINT: &str = "https://openapi.youdao.com/ocrapi";
/// OCR 图片最大边长
pub(super) const YOUDAO_MAX_IMAGE_SIDE: u32 = 2048;
/// OCR 限制 base64 编码后小于 2M
pub(super) const YOUDAO_MAX_BASE64_LENGTH: usize = 2_000_000;
/// 文本翻译单次请求所有 q 拼接后的最大字符数（平台限制 5000，留出余量）
pub(super) const YOUDAO_TEXT_BATCH_MAX_CHARS: usize = 4000;
/// 图片翻译 Base64 编码后最大 5M
pub(super) const YOUDAO_IMAGE_MAX_BASE64_LENGTH: usize = 5_000_000;

/// v3 签名的 input：长度大于 20 时取前 10 个字符 + 长度 + 后 10 个字符
/// （按字符而非字节截取，避免多字节字符切到 UTF-8 边界外；
/// base64 等纯 ASCII 输入按字节与按字符结果一致）
pub(super) fn youdao_sign_input(text: &str) -> String {
    let char_count = text.chars().count();
    if char_count > 20 {
        let first: String = text.chars().take(10).collect();
        let last: String = text.chars().skip(char_count - 10).collect();
        format!("{}{}{}", first, char_count, last)
    } else {
        text.to_string()
    }
}

/// 生成 v3 签名：sha256(appKey + input + salt + curtime + appSecret)
pub(super) fn youdao_sign(
    app_key: &str,
    input: &str,
    salt: &str,
    curtime: &str,
    app_secret: &str,
) -> String {
    let sign_input = youdao_sign_input(input);
    hex::encode(Sha256::digest(format!(
        "{}{}{}{}{}",
        app_key, sign_input, salt, curtime, app_secret
    )))
}

/// errorCode 兼容字符串与数值两种形态，归一化为字符串（缺失返回空串）
pub(super) fn youdao_error_code(value: &Option<serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(code)) => code.clone(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// 应用代码转有道语言代码（应用语言代码与有道一致，仅处理兼容写法）
pub(super) fn map_youdao_language(code: &str) -> String {
    if code.is_empty() {
        "auto".to_string()
    } else {
        code.to_string()
    }
}
