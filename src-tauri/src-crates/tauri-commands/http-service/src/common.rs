//! http-service crate 内各在线服务共享的辅助函数

use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

pub(crate) type HmacSha256 = Hmac<Sha256>;

pub(crate) fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("[http_service] Failed to build http client: {}", e))
}

pub(crate) fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|e| format!("[http_service] Failed to create hmac: {}", e))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

/// 由 Unix 时间戳计算 UTC 日期（yyyy-MM-dd），用于 TC3 / V4 签名
pub(crate) fn utc_date_from_unix(timestamp: u64) -> String {
    let days = (timestamp / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// 由 Unix 时间戳计算 UTC 日期时间（yyyy-MM-ddTHH:mm:ssZ），用于阿里云 V3 签名
pub(crate) fn utc_datetime_from_unix(timestamp: u64) -> String {
    let date = utc_date_from_unix(timestamp);
    let secs_of_day = timestamp % 86_400;
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        date,
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

/// 将 errorCode 归一化为字符串（缺失或 null 返回空串），兼容字符串与数值两种形态
pub(crate) fn normalize_error_code(error_code: &Option<Value>) -> String {
    match error_code {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// 将坐标收敛到 u32 范围；超出 u32::MAX 的浮点值直接取上限，
/// 避免 round() 后的 float->int 转换受精度影响
pub(crate) fn clamp_to_u32(value: f64) -> u32 {
    if value.is_nan() || value <= 0.0 {
        0
    } else if value >= u32::MAX as f64 {
        u32::MAX
    } else {
        value.round() as u32
    }
}

/// 解析逗号分隔的数值串，例如 "8,2,717,30"
pub(crate) fn parse_number_list(value: &str) -> Vec<f64> {
    value
        .split(',')
        .filter_map(|item| item.trim().parse::<f64>().ok())
        .collect()
}
