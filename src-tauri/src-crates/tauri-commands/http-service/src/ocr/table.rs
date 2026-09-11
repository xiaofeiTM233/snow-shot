//! 表格识别：百度表格文字识别V2 / 阿里云 RecognizeTableOcr，结果组装为 HTML 表格

use std::time::SystemTime;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::aliyun as aliyun_ocr;
use super::baidu;
use super::prepare_image_bytes;
use super::OnlineOcrConfig;
use crate::common::{build_http_client, hmac_sha256, utc_datetime_from_unix};

const BAIDU_TABLE_ENDPOINT: &str = "https://aip.baidubce.com/rest/2.0/ocr/v1/table";
const BAIDU_TABLE_MAX_IMAGE_SIDE: u32 = 8192;
const BAIDU_TABLE_MAX_BASE64_LENGTH: usize = 8_000_000;

const ALIYUN_TABLE_OCR_ACTION: &str = "RecognizeTableOcr";
const ALIYUN_TABLE_OCR_VERSION: &str = "2021-07-07";
const ALIYUN_TABLE_MAX_BASE64_LENGTH: usize = 9_500_000;

pub async fn table_ocr_online(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let config_header = request
        .headers()
        .get("x-ocr-config")
        .ok_or("[table_ocr_online] Missing ocr config header")?
        .to_str()
        .map_err(|_| "[table_ocr_online] Invalid ocr config header")?;
    let config: OnlineOcrConfig = serde_json::from_str(
        &percent_encoding::percent_decode_str(config_header)
            .decode_utf8()
            .map_err(|e| format!("[table_ocr_online] Failed to decode ocr config: {}", e))?,
    )
    .map_err(|e| format!("[table_ocr_online] Failed to parse ocr config: {}", e))?;

    let image_data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data,
        _ => return Err("[table_ocr_online] Invalid request body".to_string()),
    };

    let image = image::load(std::io::Cursor::new(image_data), image::ImageFormat::Png)
        .map_err(|_| "[table_ocr_online] Invalid image".to_string())?;

    if config.service_type.starts_with("baidu:") {
        recognize_with_baidu(&config, &image).await
    } else if config.service_type.starts_with("aliyun:") {
        recognize_with_aliyun(&config, &image).await
    } else {
        Err(format!(
            "[table_ocr_online] Unsupported service type: {}",
            config.service_type
        ))
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// 单元格：行列起点与跨行跨列数
struct TableCell {
    row: usize,
    col: usize,
    row_span: usize,
    col_span: usize,
    text: String,
}

/// 将单元格网格组装为 HTML 表格，被跨行跨列覆盖的位置不输出
fn assemble_table_html(rows: usize, cols: usize, cells: &[TableCell]) -> String {
    if rows == 0 || cols == 0 {
        return String::new();
    }

    let mut occupied = vec![vec![false; cols]; rows];
    for cell in cells {
        for row in cell.row..(cell.row + cell.row_span).min(rows) {
            for col in cell.col..(cell.col + cell.col_span).min(cols) {
                if let Some(slot) = occupied.get_mut(row).and_then(|row| row.get_mut(col)) {
                    *slot = true;
                }
            }
        }
    }

    let mut sorted_cells: Vec<&TableCell> = cells.iter().collect();
    sorted_cells.sort_by_key(|cell| (cell.row, cell.col));

    let mut html = String::from("<table border=\"1\" style=\"border-collapse: collapse\">");
    let mut current_row: Option<usize> = None;
    for cell in sorted_cells {
        if Some(cell.row) != current_row {
            if current_row.is_some() {
                html.push_str("</tr>");
            }
            html.push_str("<tr>");
            current_row = Some(cell.row);
        }

        let row_span = cell.row_span.min(rows - cell.row);
        let col_span = cell.col_span.min(cols - cell.col);
        let mut attrs = String::new();
        if row_span > 1 {
            attrs.push_str(&format!(" rowspan=\"{}\"", row_span));
        }
        if col_span > 1 {
            attrs.push_str(&format!(" colspan=\"{}\"", col_span));
        }
        html.push_str(&format!(
            "<td{}>{}</td>",
            attrs,
            escape_html(&cell.text)
        ));
    }
    if current_row.is_some() {
        html.push_str("</tr>");
    }
    html.push_str("</table>");

    html
}

// ---------- 百度 表格文字识别V2 ----------

#[derive(Deserialize)]
struct BaiduTableResponse {
    #[serde(rename = "tables_result", default)]
    tables_result: Vec<BaiduTable>,
    #[serde(rename = "error_code", default)]
    error_code: Option<serde_json::Value>,
    #[serde(rename = "error_msg", default)]
    error_msg: Option<String>,
}

#[derive(Deserialize)]
struct BaiduTable {
    #[serde(rename = "header", default)]
    header: Vec<BaiduTableCell>,
    #[serde(rename = "body", default)]
    body: Vec<BaiduTableCell>,
    #[serde(rename = "footer", default)]
    footer: Vec<BaiduTableCell>,
}

#[derive(Deserialize)]
struct BaiduTableCell {
    #[serde(rename = "words", default)]
    words: String,
    #[serde(rename = "col_start", default)]
    col_start: Option<u32>,
    #[serde(rename = "col_end", default)]
    col_end: Option<u32>,
    #[serde(rename = "row_start", default)]
    row_start: Option<u32>,
    #[serde(rename = "row_end", default)]
    row_end: Option<u32>,
}

/// 有行列信息的单元格转 TableCell，无行列信息的按顺序排一行
fn baidu_cells_to_table_cells(
    cells: &[BaiduTableCell],
    row_offset: usize,
    sequential_row: Option<usize>,
) -> Vec<TableCell> {
    cells
        .iter()
        .enumerate()
        .map(|(index, cell)| {
            let has_position =
                cell.col_start.is_some() && cell.row_start.is_some() && cell.col_end.is_some() && cell.row_end.is_some();
            if has_position {
                TableCell {
                    row: row_offset + cell.row_start.unwrap_or(0) as usize,
                    col: cell.col_start.unwrap_or(0) as usize,
                    row_span: (cell.row_end.unwrap_or(0) as usize)
                        .saturating_sub(cell.row_start.unwrap_or(0) as usize)
                        + 1,
                    col_span: (cell.col_end.unwrap_or(0) as usize)
                        .saturating_sub(cell.col_start.unwrap_or(0) as usize)
                        + 1,
                    text: cell.words.clone(),
                }
            } else {
                TableCell {
                    row: sequential_row.unwrap_or(row_offset),
                    col: index,
                    row_span: 1,
                    col_span: 1,
                    text: cell.words.clone(),
                }
            }
        })
        .collect()
}

async fn recognize_with_baidu(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<String, String> {
    let api_key = config.api_key.trim();
    let secret_key = config.secret_key.trim();
    if api_key.is_empty() || secret_key.is_empty() {
        return Err("[table_ocr_online] Baidu API Key or Secret Key is empty".to_string());
    }

    let access_token = baidu::get_access_token(api_key, secret_key).await?;

    let image_bytes =
        prepare_image_bytes(image, BAIDU_TABLE_MAX_IMAGE_SIDE, BAIDU_TABLE_MAX_BASE64_LENGTH)?;
    let img_base64 = BASE64_STANDARD.encode(&image_bytes);
    // form 值需要 urlencode
    let img_param = urlencode(&img_base64);

    let client = build_http_client()?;
    let body = client
        .post(BAIDU_TABLE_ENDPOINT)
        .query(&[("access_token", access_token.as_str())])
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!("image={}", img_param))
        .send()
        .await
        .map_err(|e| format!("[table_ocr_online] Baidu request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("[table_ocr_online] Baidu read response failed: {}", e))?;

    let response: BaiduTableResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[table_ocr_online] Baidu parse response failed: {}, body: {}",
            e, body
        )
    })?;

    let error_code = crate::common::normalize_error_code(&response.error_code);
    if !error_code.is_empty() && error_code != "0" {
        return Err(format!(
            "[table_ocr_online] Baidu error {}: {}",
            error_code,
            response.error_msg.unwrap_or_default()
        ));
    }

    if response.tables_result.is_empty() {
        return Err("[table_ocr_online] Baidu found no table".to_string());
    }

    let mut html = String::new();
    for table in &response.tables_result {
        // header/footer 无行列信息时按顺序各排一行，body 行号偏移 header 行数
        let mut cells = baidu_cells_to_table_cells(&table.header, 0, Some(0));
        let body_offset = if table.header.is_empty() { 0 } else { 1 };
        cells.extend(baidu_cells_to_table_cells(
            &table.body,
            body_offset,
            None,
        ));

        let mut rows = body_offset
            + table
                .body
                .iter()
                .filter_map(|cell| cell.row_end.map(|row| row as usize + 1))
                .max()
                .unwrap_or(0);
        let cols = table
            .body
            .iter()
            .filter_map(|cell| cell.col_end.map(|col| col as usize + 1))
            .max()
            .unwrap_or_else(|| table.body.len());

        if !table.footer.is_empty() {
            cells.extend(baidu_cells_to_table_cells(
                &table.footer,
                0,
                Some(rows),
            ));
            rows += 1;
        }

        html.push_str(&assemble_table_html(rows, cols, &cells));
        html.push('\n');
    }

    if html.trim().is_empty() {
        return Err("[table_ocr_online] Baidu found no table".to_string());
    }

    Ok(html)
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

// ---------- 阿里云 RecognizeTableOcr ----------

#[derive(Deserialize)]
struct AliyunTableResponse {
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct AliyunTableData {
    #[serde(rename = "prism_tablesInfo", default)]
    prism_tables_info: Vec<AliyunTableInfo>,
}

#[derive(Deserialize)]
struct AliyunTableInfo {
    #[serde(rename = "cellInfos", default)]
    cell_infos: Vec<AliyunCellInfo>,
    #[serde(rename = "xCellSize", default)]
    x_cell_size: u32,
    #[serde(rename = "yCellSize", default)]
    y_cell_size: u32,
}

#[derive(Deserialize)]
struct AliyunCellInfo {
    #[serde(rename = "word", default)]
    word: String,
    #[serde(rename = "xsc", default)]
    xsc: u32,
    #[serde(rename = "xec", default)]
    xec: u32,
    #[serde(rename = "ysc", default)]
    ysc: u32,
    #[serde(rename = "yec", default)]
    yec: u32,
}

/// 阿里云 OCR ACS3 签名请求（图片二进制作为请求体），复用 OCR 模块的签名流程
async fn post_aliyun_ocr_api(
    config: &OnlineOcrConfig,
    action: &str,
    image_bytes: Vec<u8>,
) -> Result<String, String> {
    let secret_id = config.secret_id.trim();
    let secret_key = config.secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err("[table_ocr_online] Aliyun AccessKeyId or AccessKeySecret is empty".to_string());
    }

    let now = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("[table_ocr_online] Failed to get current time: {}", e))?;
    let timestamp = now.as_secs();
    let x_date = utc_datetime_from_unix(timestamp);
    let nonce = hex::encode(Sha256::digest(format!(
        "{}{}{}",
        timestamp,
        now.subsec_nanos(),
        std::process::id()
    )))[..32]
        .to_string();

    let payload_hash = hex::encode(Sha256::digest(&image_bytes));
    let query = format!("Action={}&Version={}", action, ALIYUN_TABLE_OCR_VERSION);
    let signed_headers =
        "content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version";
    let host = aliyun_ocr::host();
    let canonical_headers = format!(
        "content-type:application/octet-stream\nhost:{}\nx-acs-action:{}\nx-acs-content-sha256:{}\nx-acs-date:{}\nx-acs-signature-nonce:{}\nx-acs-version:{}\n",
        host, action, payload_hash, x_date, nonce, ALIYUN_TABLE_OCR_VERSION
    );
    let canonical_request = format!(
        "POST\n/\n{}\n{}\n{}\n{}",
        query, canonical_headers, signed_headers, payload_hash
    );
    let string_to_sign = format!(
        "ACS3-HMAC-SHA256\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let signature = hex::encode(hmac_sha256(secret_key.as_bytes(), string_to_sign.as_bytes())?);
    let authorization = format!(
        "ACS3-HMAC-SHA256 Credential={},SignedHeaders={},Signature={}",
        secret_id, signed_headers, signature
    );

    let client = build_http_client()?;
    let response = client
        .post(aliyun_ocr::endpoint())
        .query(&[("Action", action), ("Version", ALIYUN_TABLE_OCR_VERSION)])
        .header("Content-Type", "application/octet-stream")
        .header("x-acs-action", action)
        .header("x-acs-content-sha256", &payload_hash)
        .header("x-acs-date", &x_date)
        .header("x-acs-signature-nonce", &nonce)
        .header("x-acs-version", ALIYUN_TABLE_OCR_VERSION)
        .header("Authorization", authorization)
        .body(image_bytes)
        .send()
        .await
        .map_err(|e| format!("[table_ocr_online] Aliyun request failed: {}", e))?;

    response
        .text()
        .await
        .map_err(|e| format!("[table_ocr_online] Aliyun read response failed: {}", e))
}

async fn recognize_with_aliyun(
    config: &OnlineOcrConfig,
    image: &image::DynamicImage,
) -> Result<String, String> {
    let image_bytes =
        prepare_image_bytes(image, u32::MAX, ALIYUN_TABLE_MAX_BASE64_LENGTH)?;

    let body = post_aliyun_ocr_api(config, ALIYUN_TABLE_OCR_ACTION, image_bytes).await?;
    let response: AliyunTableResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "[table_ocr_online] Aliyun parse response failed: {}, body: {}",
            e, body
        )
    })?;

    if let Some(code) = &response.code {
        return Err(format!(
            "[table_ocr_online] Aliyun error {}: {}",
            code,
            response.message.unwrap_or_default()
        ));
    }

    let Some(data) = &response.data else {
        return Err("[table_ocr_online] Aliyun empty response".to_string());
    };
    let table_data: AliyunTableData = serde_json::from_str(data).map_err(|e| {
        format!(
            "[table_ocr_online] Aliyun parse data failed: {}, data: {}",
            e, data
        )
    })?;

    if table_data.prism_tables_info.is_empty() {
        return Err("[table_ocr_online] Aliyun found no table".to_string());
    }

    let mut html = String::new();
    for table in &table_data.prism_tables_info {
        let rows = table.y_cell_size as usize;
        let cols = table.x_cell_size as usize;
        let cells: Vec<TableCell> = table
            .cell_infos
            .iter()
            .map(|cell| TableCell {
                row: cell.ysc as usize,
                col: cell.xsc as usize,
                row_span: (cell.yec as usize + 1).saturating_sub(cell.ysc as usize),
                col_span: (cell.xec as usize + 1).saturating_sub(cell.xsc as usize),
                text: cell.word.clone(),
            })
            .collect();

        html.push_str(&assemble_table_html(rows, cols, &cells));
        html.push('\n');
    }

    if html.trim().is_empty() {
        return Err("[table_ocr_online] Aliyun found no table".to_string());
    }

    Ok(html)
}
