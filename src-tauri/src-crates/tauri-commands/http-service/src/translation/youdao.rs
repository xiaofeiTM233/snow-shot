//! 有道智云翻译：批量文本翻译 + 图片翻译

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::MachineTranslatedImageLine;
use super::build_http_client;
use super::clamp_to_u32;
use super::now_unix_secs;

const YOUDAO_TEXT_TRANSLATE_ENDPOINT: &str = "https://openapi.youdao.com/v2/api";
const YOUDAO_IMAGE_TRANSLATE_ENDPOINT: &str = "https://openapi.youdao.com/ocrtransapi";
/// 单次请求所有 q 拼接后的最大字符数（平台限制 5000，留出余量）
const YOUDAO_TEXT_BATCH_MAX_CHARS: usize = 4000;
/// 图片 Base64 编码后最大 5M
const YOUDAO_IMAGE_MAX_BASE64_LENGTH: usize = 5_000_000;

#[derive(Debug, Clone, Deserialize)]
pub(super) struct YoudaoImageTranslateConfig {
    /// 有道 应用ID（appKey）
    #[serde(default)]
    pub app_key: String,
    /// 有道 应用密钥
    #[serde(default)]
    pub app_secret: String,
    /// 源语言，取值跟随有道文档（zh-CHS、en 等），支持 auto
    #[serde(default)]
    pub from: String,
    /// 目标语言
    #[serde(default)]
    pub to: String,
}

/// 有道签名 v3 的 input：长度大于 20 时取前 10 个字符 + 长度 + 后 10 个字符（按字符而非字节，避免多字节字符截断到 UTF-8 边界外）
fn youdao_sign_input(text: &str) -> String {
    let char_count = text.chars().count();
    if char_count > 20 {
        let first: String = text.chars().take(10).collect();
        let last: String = text.chars().skip(char_count - 10).collect();
        format!("{}{}{}", first, char_count, last)
    } else {
        text.to_string()
    }
}

/// errorCode 兼容字符串与数值两种形态，归一化为字符串（缺失返回空串）
fn youdao_error_code(value: &Option<serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(code)) => code.clone(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// 应用代码转有道语言代码（应用语言代码与有道一致，仅处理兼容写法）
fn map_youdao_language(code: &str) -> String {
    if code.is_empty() {
        "auto".to_string()
    } else {
        code.to_string()
    }
}

/// 有道批量文本翻译：多个文本按总字符数分批，重复 q 字段提交
pub async fn translate_text_youdao(
    app_key: String,
    app_secret: String,
    texts: Vec<String>,
    from: String,
    to: String,
) -> Result<Vec<String>, String> {
    let context = "[translate_text_youdao]";
    let app_key = app_key.trim();
    let app_secret = app_secret.trim();
    if app_key.is_empty() || app_secret.is_empty() {
        return Err(format!("{} Youdao appKey or appSecret is empty", context));
    }

    // 按拼接后字符数分批；超长文本单独按上限拆分为多个片段
    let mut batches: Vec<Vec<String>> = Vec::new();
    let mut current_batch: Vec<String> = Vec::new();
    let mut current_chars = 0usize;
    for text in texts {
        if text.is_empty() {
            current_batch.push(text);
            continue;
        }

        let text_chars = text.chars().count();
        if text_chars > YOUDAO_TEXT_BATCH_MAX_CHARS {
            if !current_batch.is_empty() {
                batches.push(std::mem::take(&mut current_batch));
                current_chars = 0;
            }
            let mut chunk = String::new();
            let mut chunk_chars = 0usize;
            for ch in text.chars() {
                chunk.push(ch);
                chunk_chars += 1;
                if chunk_chars == YOUDAO_TEXT_BATCH_MAX_CHARS {
                    batches.push(vec![std::mem::take(&mut chunk)]);
                    chunk_chars = 0;
                }
            }
            if !chunk.is_empty() {
                batches.push(vec![chunk]);
            }
            continue;
        }

        if current_chars + text_chars > YOUDAO_TEXT_BATCH_MAX_CHARS && !current_batch.is_empty() {
            batches.push(std::mem::take(&mut current_batch));
            current_chars = 0;
        }
        current_chars += text_chars;
        current_batch.push(text);
    }
    if !current_batch.is_empty() {
        batches.push(current_batch);
    }

    let client = build_http_client()?;
    let from = map_youdao_language(&from);
    let to = if to.is_empty() {
        "zh-CHS".to_string()
    } else {
        to
    };

    let mut results: Vec<String> = Vec::new();
    for batch in batches {
        // 签名 input 为多个 q 直接拼接后的字符串
        let joined = batch.join("");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("{} Failed to get current time: {}", context, e))?;
        let curtime = now.as_secs().to_string();
        let salt = format!("{:x}{}", now.subsec_nanos(), std::process::id());

        // 签名规则：sha256(appKey + input + salt + curtime + appSecret)
        let sign_input = youdao_sign_input(&joined);
        let sign = hex::encode(Sha256::digest(format!(
            "{}{}{}{}{}",
            app_key, sign_input, salt, curtime, app_secret
        )));

        let mut form: Vec<(&str, String)> = vec![
            ("from", from.clone()),
            ("to", to.clone()),
            ("appKey", app_key.to_string()),
            ("salt", salt),
            ("curtime", curtime),
            ("sign", sign),
            ("signType", "v3".to_string()),
            ("docType", "json".to_string()),
        ];
        for text in &batch {
            form.push(("q", text.clone()));
        }

        let response = client
            .post(YOUDAO_TEXT_TRANSLATE_ENDPOINT)
            .form(&form)
            .send()
            .await
            .map_err(|e| format!("{} Youdao request failed: {}", context, e))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("{} Youdao read response failed: {}", context, e))?;

        #[derive(Deserialize)]
        struct YoudaoBatchTranslateResponse {
            #[serde(rename = "errorCode", default)]
            error_code: Option<serde_json::Value>,
            #[serde(rename = "translateResults", default)]
            translate_results: Vec<YoudaoBatchTranslateResult>,
        }
        #[derive(Deserialize)]
        struct YoudaoBatchTranslateResult {
            #[serde(rename = "translation", default)]
            translation: Option<String>,
        }

        let translate_response: YoudaoBatchTranslateResponse =
            serde_json::from_str(&body).map_err(|e| {
                format!(
                    "{} Youdao parse response failed: {}, status: {}, body: {}",
                    context, e, status, body
                )
            })?;

        let error_code = youdao_error_code(&translate_response.error_code);
        if error_code != "0" {
            return Err(format!("{} Youdao error {}", context, error_code));
        }

        // 失败的条目可能从结果中省略（仅标记在 errorIndex 中），按位置对齐，缺失的补空串
        for index in 0..batch.len() {
            results.push(
                translate_response
                    .translate_results
                    .get(index)
                    .and_then(|item| item.translation.clone())
                    .unwrap_or_default(),
            );
        }
    }

    Ok(results)
}

/// 有道图片翻译：整图提交，按逐行明细（回退区域级）返回原文、译文与文本框
pub(super) async fn translate_image(
    config: YoudaoImageTranslateConfig,
    image_data: &[u8],
) -> Result<Vec<MachineTranslatedImageLine>, String> {
    let context = "[translate_image_youdao]";

    let app_key = config.app_key.trim();
    let app_secret = config.app_secret.trim();
    if app_key.is_empty() || app_secret.is_empty() {
        return Err(format!("{} Youdao appKey or appSecret is empty", context));
    }

    let img_base64 = BASE64_STANDARD.encode(image_data);
    if img_base64.len() > YOUDAO_IMAGE_MAX_BASE64_LENGTH {
        return Err(format!("{} Image too large (base64 > 5M)", context));
    }

    let curtime = now_unix_secs()?.to_string();
    let salt = format!(
        "{:x}{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.subsec_nanos())
            .unwrap_or_default(),
        std::process::id()
    );

    // 签名规则与文本翻译一致，input 基于图片的 Base64 字符串
    let sign_input = youdao_sign_input(&img_base64);
    let sign = hex::encode(Sha256::digest(format!(
        "{}{}{}{}{}",
        app_key, sign_input, salt, curtime, app_secret
    )));

    let from = map_youdao_language(&config.from);
    let to = if config.to.is_empty() {
        "zh-CHS".to_string()
    } else {
        config.to.clone()
    };

    let client = build_http_client()?;
    let response = client
        .post(YOUDAO_IMAGE_TRANSLATE_ENDPOINT)
        .form(&[
            ("type", "1".to_string()),
            ("q", img_base64),
            ("from", from),
            ("to", to),
            ("appKey", app_key.to_string()),
            ("salt", salt),
            ("curtime", curtime),
            ("sign", sign),
            ("signType", "v3".to_string()),
            ("docType", "json".to_string()),
            // render=1 时响应携带逐行明细（lines / transLines），便于在原文行位置显示译文
            ("render", "1".to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("{} Youdao request failed: {}", context, e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("{} Youdao read response failed: {}", context, e))?;

    #[derive(Deserialize)]
    struct YoudaoImageTranslateResponse {
        #[serde(rename = "errorCode", default)]
        error_code: Option<serde_json::Value>,
        /// 顶层源文本行（部分服务返回，配合各区域 transLines 顺序对应）
        #[serde(default)]
        lines: Vec<YoudaoSourceLine>,
        #[serde(rename = "resRegions", default)]
        res_regions: Vec<YoudaoImageTranslateRegion>,
    }
    #[derive(Deserialize)]
    struct YoudaoSourceLine {
        #[serde(default)]
        text: String,
        #[serde(rename = "boundingBox", default)]
        bounding_box: String,
        #[serde(rename = "verticesBoundingBox", default)]
        vertices_bounding_box: String,
    }
    #[derive(Deserialize)]
    struct YoudaoImageTranslateRegion {
        #[serde(rename = "boundingBox", default)]
        bounding_box: String,
        /// 区域原文
        #[serde(rename = "context", default)]
        context: String,
        /// 区域译文
        #[serde(rename = "tranContent", default)]
        tran_content: String,
        /// 区域内源文本行（对象或纯文本两种形态）
        #[serde(default)]
        lines: Vec<YoudaoRegionSourceLine>,
        /// 区域内译文行（render=1 时返回）
        #[serde(rename = "transLines", default)]
        trans_lines: Vec<YoudaoTransLine>,
    }
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum YoudaoRegionSourceLine {
        Object(YoudaoSourceLine),
        Text(String),
    }
    #[derive(Deserialize)]
    struct YoudaoTransLine {
        #[serde(default)]
        content: String,
        #[serde(rename = "verticesBoundingBox", default)]
        vertices_bounding_box: String,
    }

    let translate_response: YoudaoImageTranslateResponse =
        serde_json::from_str(&body).map_err(|e| {
            format!(
                "{} Youdao parse response failed: {}, status: {}, body: {}",
                context, e, status, body
            )
        })?;

    let error_code = youdao_error_code(&translate_response.error_code);
    if error_code != "0" {
        return Err(format!("{} Youdao error {}", context, error_code));
    }

    let parse_box_values = |box_text: &str| -> Option<(u32, u32, u32, u32)> {
        let values: Vec<f64> = box_text
            .split(',')
            .filter_map(|part| part.trim().parse::<f64>().ok())
            .collect();
        box_values_to_rect(&values).map(|(x, y, width, height)| {
            (
                clamp_to_u32(x),
                clamp_to_u32(y),
                clamp_to_u32(width),
                clamp_to_u32(height),
            )
        })
    };

    // 顶层 lines 与各区域 transLines 总数一致、且区域自身不携带 lines 时，按顺序跨区域对应源行
    let total_trans_count: usize = translate_response
        .res_regions
        .iter()
        .map(|region| region.trans_lines.len())
        .sum();
    let use_top_level_lines = !translate_response.lines.is_empty()
        && translate_response
            .res_regions
            .iter()
            .all(|region| region.lines.is_empty())
        && total_trans_count == translate_response.lines.len();
    let mut top_level_line_index = 0usize;

    let mut lines = Vec::new();
    for region in &translate_response.res_regions {
        let mut region_lines: Vec<MachineTranslatedImageLine> = Vec::new();

        // 逐行明细：译文行与源行按顺序一一对应
        if !region.trans_lines.is_empty() {
            let line_count = region.trans_lines.len();
            let region_has_lines = line_count == region.lines.len();
            let top_level_has_lines = use_top_level_lines
                && top_level_line_index + line_count <= translate_response.lines.len();

            if region_has_lines || top_level_has_lines {
                for (index, trans_line) in region.trans_lines.iter().enumerate() {
                    if trans_line.content.trim().is_empty() {
                        continue;
                    }

                    // 源行文本与框：区域 lines 优先，其次顶层 lines
                    let (source_text, source_box) = if region_has_lines {
                        match &region.lines[index] {
                            YoudaoRegionSourceLine::Object(line) => (
                                line.text.clone(),
                                if line.vertices_bounding_box.is_empty() {
                                    line.bounding_box.clone()
                                } else {
                                    line.vertices_bounding_box.clone()
                                },
                            ),
                            YoudaoRegionSourceLine::Text(text) => {
                                (text.clone(), String::new())
                            }
                        }
                    } else {
                        let line = &translate_response.lines[top_level_line_index + index];
                        (
                            line.text.clone(),
                            if line.vertices_bounding_box.is_empty() {
                                line.bounding_box.clone()
                            } else {
                                line.vertices_bounding_box.clone()
                            },
                        )
                    };

                    // 译文框优先使用服务端排版的 verticesBoundingBox，缺省时退回源行框
                    let box_text = if trans_line.vertices_bounding_box.is_empty() {
                        source_box
                    } else {
                        trans_line.vertices_bounding_box.clone()
                    };

                    if let Some((box_x, box_y, box_width, box_height)) =
                        parse_box_values(&box_text)
                    {
                        region_lines.push(MachineTranslatedImageLine {
                            source_text,
                            translated_text: trans_line.content.clone(),
                            box_x,
                            box_y,
                            box_width,
                            box_height,
                        });
                    }
                }

                if top_level_has_lines && !region_has_lines {
                    top_level_line_index += line_count;
                }
            }
        }

        // 逐行明细缺失时：区域内源行与按 \n 拆分的译文一一对应，逐行绘制
        if region_lines.is_empty()
            && !region.lines.is_empty()
            && !region.tran_content.trim().is_empty()
        {
            let translated_parts: Vec<String> = region
                .tran_content
                .split('\n')
                .map(|part| part.trim().to_string())
                .filter(|part| !part.is_empty())
                .collect();

            if translated_parts.len() == region.lines.len() {
                if let Some((region_x, region_y, region_width, region_height)) =
                    parse_box_values(&region.bounding_box)
                {
                    let line_height = region_height as f64 / translated_parts.len() as f64;
                    for (index, translated_text) in translated_parts.iter().enumerate() {
                        // 源行自带框时用源行框，否则按行数均分区域框
                        let (source_text, line_box) = match &region.lines[index] {
                            YoudaoRegionSourceLine::Object(line) => {
                                let box_text = if line.vertices_bounding_box.is_empty() {
                                    line.bounding_box.clone()
                                } else {
                                    line.vertices_bounding_box.clone()
                                };
                                (
                                    line.text.clone(),
                                    parse_box_values(&box_text).unwrap_or((
                                        region_x,
                                        (region_y as f64 + line_height * index as f64) as u32,
                                        region_width,
                                        line_height as u32,
                                    )),
                                )
                            }
                            YoudaoRegionSourceLine::Text(text) => (
                                text.clone(),
                                (
                                    region_x,
                                    (region_y as f64 + line_height * index as f64) as u32,
                                    region_width,
                                    line_height as u32,
                                ),
                            ),
                        };

                        region_lines.push(MachineTranslatedImageLine {
                            source_text,
                            translated_text: translated_text.clone(),
                            box_x: line_box.0,
                            box_y: line_box.1,
                            box_width: line_box.2,
                            box_height: line_box.3,
                        });
                    }
                }
            }
        }

        // 完全没有逐行信息时，整段译文画进区域框
        if region_lines.is_empty() && !region.tran_content.trim().is_empty() {
            if let Some((box_x, box_y, box_width, box_height)) =
                parse_box_values(&region.bounding_box)
            {
                region_lines.push(MachineTranslatedImageLine {
                    source_text: region.context.clone(),
                    translated_text: region.tran_content.clone(),
                    box_x,
                    box_y,
                    box_width,
                    box_height,
                });
            }
        }

        lines.extend(region_lines);
    }

    Ok(lines)
}

/// 有道框字符串数值转矩形（x, y, width, height）：
/// 8 个数值时为四个顶点（取外接矩形），4 个数值时为 x,y,宽,高
fn box_values_to_rect(values: &[f64]) -> Option<(f64, f64, f64, f64)> {
    if values.len() >= 8 {
        let mut min_x = f64::MAX;
        let mut min_y = f64::MAX;
        let mut max_x = f64::MIN;
        let mut max_y = f64::MIN;
        for chunk in values[..8].chunks(2) {
            min_x = min_x.min(chunk[0]);
            max_x = max_x.max(chunk[0]);
            min_y = min_y.min(chunk[1]);
            max_y = max_y.max(chunk[1]);
        }
        Some((min_x, min_y, max_x - min_x, max_y - min_y))
    } else if values.len() >= 4 {
        Some((values[0], values[1], values[2], values[3]))
    } else {
        None
    }
}
