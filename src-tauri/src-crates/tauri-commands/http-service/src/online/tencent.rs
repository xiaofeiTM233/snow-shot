//! 腾讯云共享部分：TMT 服务 TC3 请求、语言码

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::hmac_sha256;
use super::now_unix_secs;
use super::utc_date_from_unix;

/// 腾讯云机器翻译 TMT 服务
pub(super) const TENCENT_TMT_ENDPOINT: &str = "https://tmt.tencentcloudapi.com";
pub(super) const TENCENT_TMT_HOST: &str = "tmt.tencentcloudapi.com";
pub(super) const TENCENT_TMT_SERVICE: &str = "tmt";
pub(super) const TENCENT_TMT_VERSION: &str = "2018-03-21";
pub(super) const TENCENT_DEFAULT_REGION: &str = "ap-guangzhou";

/// 应用代码转腾讯云语言代码（zh-CHS -> zh、zh-CHT -> zh-TW，其余透传）
pub(super) fn map_tencent_language(code: &str) -> String {
    match code {
        "zh-CHS" => "zh".to_string(),
        "zh-CHT" => "zh-TW".to_string(),
        other => other.to_string(),
    }
}

/// 腾讯云 TMT 接口请求：TC3-HMAC-SHA256 签名，返回原始响应文本
pub(super) async fn tencent_tmt_request(
    context: &str,
    action: &str,
    payload: String,
    secret_id: &str,
    secret_key: &str,
    region: &str,
) -> Result<String, String> {
    let timestamp = now_unix_secs()?;
    let date = utc_date_from_unix(timestamp);

    let hashed_payload = hex::encode(Sha256::digest(payload.as_bytes()));
    // CanonicalHeaders 每行以 \n 结尾，与 SignedHeaders 之间还需再分隔一个空行
    let canonical_request = format!(
        "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{}\nx-tc-action:{}\n\ncontent-type;host;x-tc-action\n{}",
        TENCENT_TMT_HOST,
        action.to_lowercase(),
        hashed_payload
    );
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{}\n{}/{}/tc3_request\n{}",
        timestamp,
        date,
        TENCENT_TMT_SERVICE,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );

    // 派生签名密钥：TC3+SecretKey -> 日期 -> 服务名 -> "tc3_request"
    let secret_date = hmac_sha256(format!("TC3{}", secret_key).as_bytes(), date.as_bytes())?;
    let secret_service = hmac_sha256(&secret_date, TENCENT_TMT_SERVICE.as_bytes())?;
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request")?;
    let signature = hex::encode(hmac_sha256(&secret_signing, string_to_sign.as_bytes())?);

    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={}/{}/{}/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature={}",
        secret_id, date, TENCENT_TMT_SERVICE, signature
    );

    let client = super::build_http_client()?;
    let response = client
        .post(TENCENT_TMT_ENDPOINT)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("X-TC-Action", action)
        .header("X-TC-Version", TENCENT_TMT_VERSION)
        .header("X-TC-Timestamp", timestamp.to_string())
        .header("X-TC-Region", region)
        .header("Authorization", authorization)
        .body(payload)
        .send()
        .await
        .map_err(|e| format!("{} Tencent request failed: {}", context, e))?;

    response
        .text()
        .await
        .map_err(|e| format!("{} Tencent read response failed: {}", context, e))
}

/// TMT 接口响应外层结构（bound 覆盖 serde 对泛型字段 default 保守要求的 T: Default）
#[derive(Deserialize)]
#[serde(bound(deserialize = "T: serde::de::Deserialize<'de>"))]
pub(super) struct TencentTmtResponse<T> {
    #[serde(rename = "Response", default)]
    pub response: Option<T>,
}

#[derive(Deserialize)]
pub(super) struct TencentTmtError {
    #[serde(rename = "Code", default)]
    pub code: String,
    #[serde(rename = "Message", default)]
    pub message: String,
}
