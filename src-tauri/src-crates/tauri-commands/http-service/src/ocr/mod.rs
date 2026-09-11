mod aliyun;
mod baidu;
mod custom;
pub mod table;
mod tencent;
mod volcengine;
mod youdao;

use std::io::Cursor;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use snow_shot_app_services::ocr_service::{OcrDetectResult, Point, TextBlock};

use crate::common::{clamp_to_u32, parse_number_list};

pub(crate) const YOUDAO_SERVICE_TYPE_PREFIX: &str = "youdao:";
pub(crate) const TENCENT_SERVICE_TYPE_PREFIX: &str = "tencent:";
pub(crate) const BAIDU_SERVICE_TYPE_PREFIX: &str = "baidu:";
pub(crate) const ALIYUN_SERVICE_TYPE_PREFIX: &str = "aliyun:";
pub(crate) const VOLC_SERVICE_TYPE_PREFIX: &str = "volcengine:";
pub(crate) const CUSTOM_SERVICE_TYPE_PREFIX: &str = "custom:";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineOcrConfig {
    /// 服务类型，格式为 `provider:service`，例如 `youdao:ocr`、`tencent:GeneralBasicOCR`
    pub service_type: String,
    /// 识别语言，取值跟随对应平台文档
    #[serde(default)]
    pub language: String,
    /// 翻译目标语言，仅图片翻译类服务使用
    #[serde(default)]
    pub target_language: String,
    /// 自定义 API 地址
    #[serde(default)]
    pub api_uri: String,
    /// 百度 API Key
    #[serde(default)]
    pub api_key: String,
    /// 有道 应用ID（appKey）
    #[serde(default)]
    pub app_key: String,
    /// 有道 应用密钥
    #[serde(default)]
    pub app_secret: String,
    /// 腾讯云 SecretId / 阿里云 AccessKeyId / 火山引擎 AccessKeyId
    #[serde(default)]
    pub secret_id: String,
    /// 腾讯云 SecretKey / 阿里云 AccessKeySecret / 火山引擎 SecretAccessKey / 百度 Secret Key
    #[serde(default)]
    pub secret_key: String,
    /// 腾讯云 地域
    #[serde(default)]
    pub region: String,
}

pub async fn ocr_detect_online(
    request: tauri::ipc::Request<'_>,
) -> Result<OcrDetectResult, String> {
    log::info!("[ocr_detect_online] start detect");

    let config_header = request
        .headers()
        .get("x-ocr-config")
        .ok_or("[ocr_detect_online] Missing ocr config header")?
        .to_str()
        .map_err(|_| "[ocr_detect_online] Invalid ocr config header")?;
    let config_json = percent_decode_str(config_header)
        .decode_utf8()
        .map_err(|e| format!("[ocr_detect_online] Failed to decode ocr config: {}", e))?;
    let config: OnlineOcrConfig = serde_json::from_str(&config_json)
        .map_err(|e| format!("[ocr_detect_online] Failed to parse ocr config: {}", e))?;

    let image_data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data,
        _ => return Err("[ocr_detect_online] Invalid request body".to_string()),
    };

    let detect_angle = request
        .headers()
        .get("x-detect-angle")
        .and_then(|value| value.to_str().ok())
        .map(|value| value == "true")
        .unwrap_or(false);

    let image = image::load(Cursor::new(image_data), image::ImageFormat::Png)
        .map_err(|_| "[ocr_detect_online] Invalid image".to_string())?;

    // 图片翻译类服务需要在前缀判断之前处理，避免被同名厂商的 OCR 服务拦截
    if config.service_type == crate::translation::YOUDAO_IMAGE_TRANSLATION_SERVICE_TYPE {
        crate::translation::youdao::translate_image_as_ocr(&config, &image).await
    } else if config.service_type == crate::translation::ALIYUN_IMAGE_TRANSLATION_SERVICE_TYPE {
        crate::translation::aliyun::translate_image_as_ocr(&config, &image).await
    } else if config.service_type == crate::translation::VOLC_IMAGE_TRANSLATION_SERVICE_TYPE {
        crate::translation::volcengine::translate_image_as_ocr(&config, &image).await
    } else if config.service_type == crate::translation::BAIDU_IMAGE_TRANSLATION_SERVICE_TYPE {
        crate::translation::baidu::translate_image_as_ocr(&config, &image).await
    } else if config.service_type.starts_with(YOUDAO_SERVICE_TYPE_PREFIX) {
        youdao::detect_with_youdao(&config, &image, detect_angle).await
    } else if config.service_type.starts_with(TENCENT_SERVICE_TYPE_PREFIX) {
        tencent::detect_with_tencent(&config, &image).await
    } else if config.service_type.starts_with(BAIDU_SERVICE_TYPE_PREFIX) {
        baidu::detect_with_baidu(&config, &image, detect_angle).await
    } else if config.service_type.starts_with(ALIYUN_SERVICE_TYPE_PREFIX) {
        aliyun::detect_with_aliyun(&config, &image).await
    } else if config.service_type.starts_with(VOLC_SERVICE_TYPE_PREFIX) {
        volcengine::detect_with_volc(&config, &image).await
    } else if config.service_type.starts_with(CUSTOM_SERVICE_TYPE_PREFIX) {
        custom::detect_with_custom(&config, &image).await
    } else {
        Err(format!(
            "[ocr_detect_online] Unknown service type: {}",
            config.service_type
        ))
    }
}

/// 压缩图片以满足在线平台的限制：超过最大边长时等比缩放，体积仍超限时降级为 JPEG
pub(crate) fn prepare_image_bytes(
    image: &image::DynamicImage,
    max_side: u32,
    max_base64_length: usize,
) -> Result<Vec<u8>, String> {
    // 拒绝无有效尺寸的图片，避免后续缩放与编码产生异常结果
    if image.width() == 0 || image.height() == 0 {
        return Err("[ocr_detect_online] Invalid image size".to_string());
    }

    let mut img = image.clone();
    let longest_side = img.width().max(img.height());
    if longest_side > max_side {
        let scale = max_side as f32 / longest_side as f32;
        img = img.resize(
            ((img.width() as f32 * scale) as u32).max(1),
            ((img.height() as f32 * scale) as u32).max(1),
            image::imageops::FilterType::Lanczos3,
        );
    }

    let mut png_bytes = Vec::new();
    img.write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("[ocr_detect_online] Failed to encode image: {}", e))?;

    if BASE64_STANDARD.encode(&png_bytes).len() < max_base64_length {
        return Ok(png_bytes);
    }

    for quality in [90u8, 80u8] {
        let mut jpeg_bytes = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, quality);
        img.write_with_encoder(encoder)
            .map_err(|e| format!("[ocr_detect_online] Failed to encode image: {}", e))?;
        if BASE64_STANDARD.encode(&jpeg_bytes).len() < max_base64_length {
            return Ok(jpeg_bytes);
        }
    }

    Err("[ocr_detect_online] Image is too large to send".to_string())
}

/// 将矩形 (x, y, 宽, 高) 转为四个角点（左上/右上/右下/左下）
pub(crate) fn rect_to_box_points(x: f64, y: f64, width: f64, height: f64) -> Vec<Point> {
    vec![
        Point {
            x: clamp_to_u32(x),
            y: clamp_to_u32(y),
        },
        Point {
            x: clamp_to_u32(x + width),
            y: clamp_to_u32(y),
        },
        Point {
            x: clamp_to_u32(x + width),
            y: clamp_to_u32(y + height),
        },
        Point {
            x: clamp_to_u32(x),
            y: clamp_to_u32(y + height),
        },
    ]
}

/// 解析有道系服务的 boundingBox 字符串为四个角点（左上/右上/右下/左下）：
/// 8 个数值时依次为 左上(x,y)、右上(x,y)、右下(x,y)、左下(x,y)，
/// 4 个数值时为 x,y,宽,高
pub(crate) fn parse_bounding_box(bounding_box: &str) -> Option<Vec<Point>> {
    let values = parse_number_list(bounding_box);
    match values.len() {
        len if len >= 8 => Some(
            values[..8]
                .chunks(2)
                .map(|chunk| Point {
                    x: clamp_to_u32(chunk[0]),
                    y: clamp_to_u32(chunk[1]),
                })
                .collect(),
        ),
        len if len >= 4 => Some(rect_to_box_points(
            values[0], values[1], values[2], values[3],
        )),
        _ => None,
    }
}

/// 有道系服务（有道 OCR、自定义接口）共用的文本行结构，
/// words、lang、dir 等其余字段对识别结果无用，由 serde 自动忽略
#[derive(Deserialize)]
struct OcrLine {
    #[serde(rename = "boundingBox", default)]
    bounding_box: String,
    #[serde(rename = "verticesBoundingBox", default)]
    vertices_bounding_box: String,
    #[serde(default)]
    text: String,
}

/// 将有道系服务的文本行转换为 OCR 识别结果：
/// 优先使用 verticesBoundingBox（携带旋转信息），缺省时退回 boundingBox
fn ocr_line_to_text_block(line: &OcrLine) -> Option<TextBlock> {
    let box_points = if line.vertices_bounding_box.is_empty() {
        parse_bounding_box(&line.bounding_box)?
    } else {
        parse_bounding_box(&line.vertices_bounding_box)
            .or_else(|| parse_bounding_box(&line.bounding_box))?
    };

    Some(TextBlock {
        box_points,
        box_score: 1.0,
        angle_index: 0,
        angle_score: 0.0,
        text: line.text.clone(),
        text_score: 1.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point_coords(points: &[Point]) -> Vec<(u32, u32)> {
        points.iter().map(|p| (p.x, p.y)).collect()
    }

    #[test]
    fn test_parse_bounding_box_rect() {
        // 4 值格式：x,y,宽,高
        let points = parse_bounding_box("8,2,717,30").unwrap();
        assert_eq!(
            point_coords(&points),
            vec![(8, 2), (725, 2), (725, 32), (8, 32)]
        );
    }

    #[test]
    fn test_parse_bounding_box_corners() {
        // 8 值格式：左上(x,y)、右上(x,y)、右下(x,y)、左下(x,y)
        let points = parse_bounding_box("1,2,3,4,5,6,7,8").unwrap();
        assert_eq!(
            point_coords(&points),
            vec![(1, 2), (3, 4), (5, 6), (7, 8)]
        );
    }

    #[test]
    fn test_parse_bounding_box_invalid() {
        assert!(parse_bounding_box("").is_none());
        assert!(parse_bounding_box("abc").is_none());
        assert!(parse_bounding_box("1,2,3").is_none());
    }

    #[test]
    fn test_ocr_line_to_text_block_prefers_vertices() {
        let line = OcrLine {
            bounding_box: "0,0,10,10".to_string(),
            vertices_bounding_box: "1,1,2,1,2,2,1,2".to_string(),
            text: "hello".to_string(),
        };

        let block = ocr_line_to_text_block(&line).unwrap();
        assert_eq!(block.text, "hello");
        assert_eq!(
            point_coords(&block.box_points),
            vec![(1, 1), (2, 1), (2, 2), (1, 2)]
        );

        // vertices 缺省时退回 boundingBox
        let line = OcrLine {
            bounding_box: "0,0,10,10".to_string(),
            vertices_bounding_box: String::new(),
            text: "world".to_string(),
        };

        let block = ocr_line_to_text_block(&line).unwrap();
        assert_eq!(
            point_coords(&block.box_points),
            vec![(0, 0), (10, 0), (10, 10), (0, 10)]
        );
    }
}
