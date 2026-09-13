use std::path::{Path, PathBuf};

use num_cpus;
use ort::session::builder::SessionBuilder;
use paddle_ocr_rs::ocr_lite::OcrLite;
use serde::{Deserialize, Serialize};

/// OCR 结果类型，供本地 / 在线 OCR 及翻译模块共用
pub use paddle_ocr_rs::ocr_result::{Point, TextBlock};

#[derive(Serialize, Deserialize)]
pub struct OcrDetectResult {
    pub text_blocks: Vec<TextBlock>,
    pub scale_factor: f32,
}

pub struct OcrService {
    hot_start: bool,
    ocr_core: Option<OcrLite>,
    det_model: Option<(PathBuf, Option<Vec<u8>>)>,
    rec_model: Option<(PathBuf, Option<Vec<u8>>)>,
    cls_model: Option<(PathBuf, Option<Vec<u8>>)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Copy, PartialOrd, Serialize, Deserialize)]
pub enum OcrModel {
    RapidOcrV4,
}

impl OcrService {
    pub fn new() -> Self {
        Self {
            hot_start: false,
            ocr_core: None,
            det_model: None,
            rec_model: None,
            cls_model: None,
        }
    }

    async fn read_model_data(
        &self,
        det_path: &Path,
        cls_path: &Path,
        rec_path: &Path,
    ) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), String> {
        let (det_result, cls_result, rec_result) = tokio::join!(
            tokio::fs::read(det_path),
            tokio::fs::read(cls_path),
            tokio::fs::read(rec_path)
        );

        Ok((
            det_result.map_err(|e| {
                format!(
                    "[OcrService::read_model_data] Failed to read det model data: {}",
                    e
                )
            })?,
            cls_result.map_err(|e| {
                format!(
                    "[OcrService::read_model_data] Failed to read cls model data: {}",
                    e
                )
            })?,
            rec_result.map_err(|e| {
                format!(
                    "[OcrService::read_model_data] Failed to read rec model data: {}",
                    e
                )
            })?,
        ))
    }

    fn build_session(builder: SessionBuilder) -> Result<SessionBuilder, ort::Error> {
        let num_thread = num_cpus::get_physical();
        Ok(builder
            .with_inter_threads(num_thread)?
            .with_intra_threads(num_thread)?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?)
    }

    pub async fn init_session(&mut self) -> Result<(), String> {
        let ((det_path, det_model_data), (cls_path, cls_model_data), (rec_path, rec_model_data)) = (
            self.det_model
                .as_ref()
                .expect("[OcrService::init_ocr_core] Det model is not loaded"),
            self.cls_model
                .as_ref()
                .expect("[OcrService::init_ocr_core] Cls model is not loaded"),
            self.rec_model
                .as_ref()
                .expect("[OcrService::init_ocr_core] Rec model is not loaded"),
        );

        let mut ocr_core = OcrLite::new();

        if let (Some(det_model_data), Some(cls_model_data), Some(rec_model_data)) =
            (det_model_data, cls_model_data, rec_model_data)
        {
            ocr_core.init_models_from_memory_custom(
                det_model_data,
                cls_model_data,
                rec_model_data,
                Self::build_session,
            )
        } else {
            let (det_model_data, cls_model_data, rec_model_data) =
                self.read_model_data(det_path, cls_path, rec_path).await?;

            ocr_core.init_models_from_memory_custom(
                det_model_data.as_ref(),
                cls_model_data.as_ref(),
                rec_model_data.as_ref(),
                Self::build_session,
            )
        }
        .map_err(|e| format!("[OcrService::init_ocr_core] Failed to init models: {}", e))?;

        self.ocr_core.replace(ocr_core);

        Ok(())
    }

    pub async fn init_models(
        &mut self,
        orc_plugin_path: PathBuf,
        det_model_name: Option<String>,
        cls_model_name: Option<String>,
        rec_model_name: Option<String>,
        hot_start: bool,
        ocr_model_write_to_memory: bool,
    ) -> Result<(), String> {
        let det_file = det_model_name.unwrap_or_else(|| "ch_PP-OCRv4_det_infer.onnx".to_string());
        let cls_file = cls_model_name.unwrap_or_else(|| "ch_ppocr_mobile_v2.0_cls_infer.onnx".to_string());
        let rec_file = rec_model_name.unwrap_or_else(|| "ch_PP-OCRv4_rec_infer.onnx".to_string());

        log::info!(
            "[OcrService::init_models] orc_plugin_path: {:?}, det: {}, cls: {}, rec: {}, hot_start: {:?}, ocr_model_write_to_memory: {:?}",
            orc_plugin_path,
            det_file,
            cls_file,
            rec_file,
            hot_start,
            ocr_model_write_to_memory
        );

        let det_model_path = orc_plugin_path.join(&det_file);
        let cls_model_path = orc_plugin_path.join(&cls_file);
        let rec_model_path = orc_plugin_path.join(&rec_file);

        let (det_model_config, cls_model_config, rec_model_config) = if ocr_model_write_to_memory {
            let (det_result, cls_result, rec_result) = self
                .read_model_data(&det_model_path, &cls_model_path, &rec_model_path)
                .await?;

            (
                Some((det_model_path, Some(det_result))),
                Some((cls_model_path, Some(cls_result))),
                Some((rec_model_path, Some(rec_result))),
            )
        } else {
            (
                Some((det_model_path, None)),
                Some((cls_model_path, None)),
                Some((rec_model_path, None)),
            )
        };

        self.det_model = det_model_config;
        self.cls_model = cls_model_config;
        self.rec_model = rec_model_config;
        self.hot_start = hot_start;

        if self.hot_start {
            self.init_session().await?;
        } else {
            self.ocr_core.take();
        }

        Ok(())
    }

    /// 释放 onnx session，并初始化新的 session
    pub async fn release_session(&mut self) -> Result<(), String> {
        if self.hot_start {
            self.init_session().await?;
        } else {
            self.ocr_core.take();
        }

        Ok(())
    }

    pub async fn get_session(&mut self) -> Result<&mut OcrLite, String> {
        if self.ocr_core.is_none() {
            self.init_session().await?;
        }

        Ok(self.ocr_core.as_mut().unwrap())
    }
}
