use image::{DynamicImage, GenericImageView};
use rayon::iter::{
    IndexedParallelIterator, IntoParallelIterator, IntoParallelRefIterator, ParallelIterator,
};
use serde::{Deserialize, Serialize};
use snow_shot_app_shared::ElementRect;
use xcap::Monitor;

#[cfg(target_os = "windows")]
use crate::monitor_hdr_info::{self, MonitorHdrInfo};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::HMONITOR;

#[derive(Debug)]
pub struct MonitorInfo {
    pub monitor: Monitor,
    pub rect: ElementRect,
    pub scale_factor: f32,
    #[cfg(target_os = "macos")]
    pub monitor_scale_factor: f64,
    #[cfg(target_os = "windows")]
    pub monitor_hdr_info: MonitorHdrInfo,
}

#[derive(Debug, Clone, Copy)]
pub enum ColorFormat {
    Rgba8,
    Rgb8,
}

#[derive(Serialize, Clone)]
pub struct MonitorRect {
    pub rect: ElementRect,
    pub scale_factor: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct CaptureOption {
    pub color_format: ColorFormat,
    pub correct_hdr_color_algorithm: CorrectHdrColorAlgorithm,
    pub correct_color_filter: bool,
}

impl MonitorInfo {
    pub fn new(
        monitor: &Monitor,
        #[cfg(target_os = "windows")] monitor_hdr_info: Option<MonitorHdrInfo>,
    ) -> Self {
        let monitor_rect: ElementRect;
        let scale_factor: f32;

        #[cfg(target_os = "windows")]
        {
            let rect = monitor.get_dev_mode_w().unwrap();
            monitor_rect = ElementRect {
                min_x: unsafe { rect.Anonymous1.Anonymous2.dmPosition.x },
                min_y: unsafe { rect.Anonymous1.Anonymous2.dmPosition.y },
                max_x: unsafe { rect.Anonymous1.Anonymous2.dmPosition.x + rect.dmPelsWidth as i32 },
                max_y: unsafe {
                    rect.Anonymous1.Anonymous2.dmPosition.y + rect.dmPelsHeight as i32
                },
            };
            scale_factor = monitor.scale_factor().unwrap_or(0.0);

            MonitorInfo {
                monitor: monitor.clone(),
                rect: monitor_rect,
                scale_factor,
                monitor_hdr_info: monitor_hdr_info.unwrap_or(MonitorHdrInfo::default()),
            }
        }

        #[cfg(target_os = "macos")]
        {
            let rect = monitor.bounds().unwrap();
            let monitor_scale_factor = monitor.scale_factor().unwrap_or(1.0) as f64;
            monitor_rect = ElementRect {
                min_x: (rect.origin.x * monitor_scale_factor) as i32,
                min_y: (rect.origin.y * monitor_scale_factor) as i32,
                max_x: ((rect.origin.x + rect.size.width) * monitor_scale_factor) as i32,
                max_y: ((rect.origin.y + rect.size.height) * monitor_scale_factor) as i32,
            };
            scale_factor = 0.0;

            MonitorInfo {
                monitor: monitor.clone(),
                rect: monitor_rect,
                scale_factor,
                monitor_scale_factor,
            }
        }
    }

    pub fn get_monitor_crop_region(&self, crop_region: ElementRect) -> ElementRect {
        let monitor_crop_region = self.rect.clip_rect(&ElementRect {
            min_x: crop_region.min_x,
            min_y: crop_region.min_y,
            max_x: crop_region.max_x,
            max_y: crop_region.max_y,
        });

        ElementRect {
            min_x: monitor_crop_region.min_x - self.rect.min_x,
            min_y: monitor_crop_region.min_y - self.rect.min_y,
            max_x: monitor_crop_region.max_x - self.rect.min_x,
            max_y: monitor_crop_region.max_y - self.rect.min_y,
        }
    }

    #[cfg(target_os = "windows")]
    pub fn get_monitor_handle(monitor: &Monitor) -> HMONITOR {
        use std::ffi::c_void;

        HMONITOR(monitor.id().unwrap() as *mut c_void)
    }

    /// 获取显示器设备名称
    #[cfg(target_os = "windows")]
    pub fn get_device_name(monitor: &Monitor) -> Result<String, String> {
        use widestring::U16CString;
        use windows::Win32::{
            Foundation::RECT,
            Graphics::Gdi::{GetMonitorInfoW, MONITORINFO, MONITORINFOEXW},
        };

        let mut monitor_info = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: u32::try_from(std::mem::size_of::<MONITORINFOEXW>()).unwrap(),
                rcMonitor: RECT::default(),
                rcWork: RECT::default(),
                dwFlags: 0,
            },
            szDevice: [0; 32],
        };

        let result = unsafe {
            GetMonitorInfoW(
                Self::get_monitor_handle(monitor),
                std::ptr::addr_of_mut!(monitor_info).cast(),
            )
        };

        if !result.as_bool() {
            return Err(format!(
                "[MonitorInfo::get_device_name] Failed to get monitor info: {:?}",
                result
            ));
        }

        let device_name = match U16CString::from_vec_truncate(monitor_info.szDevice).to_string() {
            Ok(name) => name,
            Err(e) => {
                return Err(format!(
                    "[MonitorInfo::get_device_name] Failed to get device name: {:?}",
                    e
                ));
            }
        };

        Ok(device_name)
    }

    pub fn capture(
        &self,
        crop_area: Option<ElementRect>,
        exclude_window: Option<&tauri::Window>,
        capture_option: CaptureOption,
    ) -> Option<image::DynamicImage> {
        #[cfg(target_os = "macos")]
        {
            return super::capture_target_monitor(
                &self.monitor,
                crop_area,
                exclude_window,
                capture_option.color_format,
            );
        }

        #[cfg(target_os = "windows")]
        {
            use crate::windows_capture_image;

            let mut capture_hdr_image: Option<image::DynamicImage> = None;
            if self.monitor_hdr_info.hdr_enabled
                && capture_option.correct_hdr_color_algorithm != CorrectHdrColorAlgorithm::None
            {
                capture_hdr_image = match windows_capture_image::capture_monitor_image(
                    &self,
                    None,
                    crop_area,
                    capture_option.color_format,
                ) {
                    Ok(image) => Some(image),
                    Err(e) => {
                        log::error!(
                            "[MonitorInfo::capture] Failed to capture HDR monitor image: {:?}",
                            e
                        );
                        None
                    }
                }
            }

            return match capture_hdr_image {
                Some(image) => Some(image),
                None => super::capture_target_monitor(
                    &self.monitor,
                    crop_area,
                    exclude_window,
                    capture_option.color_format,
                ),
            };
        }
    }
}

#[derive(Debug)]
pub struct MonitorList(Vec<MonitorInfo>);

#[derive(Serialize, Deserialize, Clone, Debug, Copy, PartialEq)]
pub enum CorrectHdrColorAlgorithm {
    None,
    Linear,
}

impl MonitorList {
    fn get_monitors(
        region: Option<ElementRect>,
        #[allow(unused_variables)] ignore_sdr_info: bool,
    ) -> MonitorList {
        let monitors = Monitor::all().unwrap_or_default();

        let region = match region {
            Some(region) => region,
            None => ElementRect {
                min_x: i32::MIN,
                min_y: i32::MIN,
                max_x: i32::MAX,
                max_y: i32::MAX,
            },
        };

        #[cfg(target_os = "windows")]
        let monitor_hdr_info_map = if ignore_sdr_info {
            None
        } else {
            match monitor_hdr_info::get_all_monitors_sdr_info() {
                Ok(monitor_hdr_info_map) => Some(monitor_hdr_info_map),
                Err(e) => {
                    log::error!(
                        "[MonitorList::get_monitors] Failed to get monitor HDR info: {:?}",
                        e
                    );
                    None
                }
            }
        };

        let monitor_info_list = monitors
            .iter()
            .map(|monitor| {
                #[cfg(target_os = "windows")]
                {
                    MonitorInfo::new(
                        monitor,
                        match &monitor_hdr_info_map {
                            Some(monitor_hdr_info_map) => Some(
                                monitor_hdr_info_map
                                    .get(
                                        MonitorInfo::get_device_name(monitor)
                                            .unwrap_or_default()
                                            .as_str(),
                                    )
                                    .unwrap_or(&MonitorHdrInfo::default())
                                    .clone(),
                            ),
                            None => None,
                        },
                    )
                }

                #[cfg(target_os = "macos")]
                {
                    MonitorInfo::new(monitor)
                }
            })
            .filter(|monitor| monitor.rect.overlaps(&region))
            .collect::<Vec<MonitorInfo>>();

        MonitorList(monitor_info_list)
    }

    pub fn all(ignore_sdr_info: bool) -> MonitorList {
        Self::get_monitors(None, ignore_sdr_info)
    }

    pub fn get_by_region(region: ElementRect, ignore_sdr_info: bool) -> MonitorList {
        Self::get_monitors(Some(region), ignore_sdr_info)
    }

    /// 获取所有显示器的最小矩形
    pub fn get_monitors_bounding_box(&self) -> ElementRect {
        let monitors = &self.0;

        if monitors.is_empty() {
            return ElementRect {
                min_x: 0,
                min_y: 0,
                max_x: 0,
                max_y: 0,
            };
        }

        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;

        for monitor in monitors {
            if monitor.rect.min_x < min_x {
                min_x = monitor.rect.min_x;
            }
            if monitor.rect.min_y < min_y {
                min_y = monitor.rect.min_y;
            }
            if monitor.rect.max_x > max_x {
                max_x = monitor.rect.max_x;
            }
            if monitor.rect.max_y > max_y {
                max_y = monitor.rect.max_y;
            }
        }

        ElementRect {
            min_x,
            min_y,
            max_x,
            max_y,
        }
    }

    /// 捕获所有显示器，拼接为一个完整的图像
    ///
    /// @param crop_region 显示器的裁剪区域
    async fn capture_future(
        &self,
        crop_region: Option<ElementRect>,
        exclude_window: Option<&tauri::Window>,
        capture_option: CaptureOption,
    ) -> Result<image::DynamicImage, String> {
        let monitors = &self.0;

        // 特殊情况，只有一个显示器，直接返回
        if monitors.len() == 1 {
            let first_monitor = monitors.first().unwrap();
            let capture_image = first_monitor.capture(
                if let Some(crop_region) = crop_region {
                    Some(first_monitor.get_monitor_crop_region(crop_region))
                } else {
                    None
                },
                exclude_window,
                capture_option,
            );

            // 有些捕获失败的显示器，返回一个空图像，这里需要特殊处理
            if let Some(capture_image) = capture_image.as_ref() {
                if capture_image.width() == 1 && capture_image.height() == 1 {
                    return match capture_option.color_format {
                        ColorFormat::Rgb8 => Ok(image::DynamicImage::new_rgb8(
                            (first_monitor.rect.max_x - first_monitor.rect.min_x) as u32,
                            (first_monitor.rect.max_y - first_monitor.rect.min_y) as u32,
                        )),
                        ColorFormat::Rgba8 => Ok(image::DynamicImage::new_rgba8(
                            (first_monitor.rect.max_x - first_monitor.rect.min_x) as u32,
                            (first_monitor.rect.max_y - first_monitor.rect.min_y) as u32,
                        )),
                    };
                }
            }

            return match capture_image {
                Some(capture_image) => Ok(capture_image),
                None => {
                    return Err(format!(
                        "[MonitorInfoList::capture] Failed to capture monitor image, monitor rect: {:?}",
                        first_monitor.rect
                    ));
                }
            };
        }

        // 将每个显示器截取的图像，绘制到该图像上
        let monitor_image_list = monitors
            .par_iter()
            .filter(|monitor| monitor.rect.overlaps(&crop_region.unwrap_or(ElementRect {
                min_x: i32::MIN,
                min_y: i32::MIN,
                max_x: i32::MAX,
                max_y: i32::MAX,
            })))
            .map(|monitor| {
                let monitor_crop_region = if let Some(crop_region) = crop_region {
                    Some(monitor.get_monitor_crop_region(crop_region))
                } else {
                    None
                };

                let capture_image = monitor.capture(monitor_crop_region, exclude_window, capture_option);

                match capture_image {
                    Some(image) => Some((image, monitor_crop_region)),
                    None => {
                        log::warn!(
                            "[MonitorInfoList::capture] Failed to capture monitor image, monitor rect: {:?}",
                            monitor.rect
                        );

                        None
                    }
                }
            })
            .filter_map(|result| match result {
                Some((image, monitor_crop_region)) => Some((image, monitor_crop_region)),
                None => None,
            })
            .collect::<Vec<(image::DynamicImage, Option<ElementRect>)>>();

        if monitor_image_list.is_empty() {
            return Err(format!(
                "[MonitorInfoList::capture] Failed to capture monitor image, monitor_image_list is empty, crop_region: {:?}",
                crop_region
            ));
        }

        // 获取能容纳所有显示器的最小矩形
        let monitors_bounding_box = self.get_monitors_bounding_box();

        // 声明该图像，分配内存
        let (capture_image_width, capture_image_height) = if let Some(crop_region) = crop_region {
            (
                (crop_region.max_x - crop_region.min_x) as usize,
                (crop_region.max_y - crop_region.min_y) as usize,
            )
        } else {
            (
                (monitors_bounding_box.max_x - monitors_bounding_box.min_x) as usize,
                (monitors_bounding_box.max_y - monitors_bounding_box.min_y) as usize,
            )
        };

        let pixel_len = match capture_option.color_format {
            ColorFormat::Rgb8 => 3,
            ColorFormat::Rgba8 => 4,
        };

        let mut capture_image_pixels: Vec<u8> =
            vec![0; capture_image_width * capture_image_height * pixel_len];

        let capture_image_pixels_ptr = capture_image_pixels.as_mut_ptr() as usize;

        monitor_image_list.par_iter().enumerate().for_each(
            |(index, (monitor_image, monitor_crop_region))| {
                let monitor = &monitors[index];

                // 计算显示器在合并图像中的位置
                let offset_x: i32;
                let offset_y: i32;

                if let Some(monitor_crop_region) = monitor_crop_region {
                    let crop_region = crop_region.unwrap();

                    // 将单个显示器的坐标转为整个显示器的坐标
                    // 得到图像相对整个显示器的坐标后，再减去裁剪区域的坐标，得到图像相对裁剪区域的坐标
                    offset_x = monitor_crop_region.min_x + monitor.rect.min_x - crop_region.min_x;
                    offset_y = monitor_crop_region.min_y + monitor.rect.min_y - crop_region.min_y;
                } else {
                    offset_x = monitor.rect.min_x - monitors_bounding_box.min_x;
                    offset_y = monitor.rect.min_y - monitors_bounding_box.min_y;
                }

                if offset_x < 0 || offset_y < 0 {
                    log::error!(
                        "[MonitorInfoList::capture] offset_x or offset_y is less than 0, offset_x: {:?}, offset_y: {:?}",
                        offset_x,
                        offset_y
                    );
                }

                // 将显示器图像绘制到合并图像上
                super::overlay_image_ptr(
                    capture_image_pixels_ptr as *mut u8,
                    capture_image_width,
                    monitor_image,
                    offset_x as usize,
                    offset_y as usize,
                    pixel_len,
                );
            },
        );

        let capture_image = match capture_option.color_format {
            ColorFormat::Rgb8 => image::DynamicImage::ImageRgb8(
                image::RgbImage::from_raw(
                    capture_image_width as u32,
                    capture_image_height as u32,
                    capture_image_pixels,
                )
                .unwrap(),
            ),
            ColorFormat::Rgba8 => image::DynamicImage::ImageRgba8(
                image::RgbaImage::from_raw(
                    capture_image_width as u32,
                    capture_image_height as u32,
                    capture_image_pixels,
                )
                .unwrap(),
            ),
        };

        Ok(capture_image)
    }

    #[inline(always)]
    fn apply_color_matrix_to_channel(
        channel_index: usize,
        red_f: f32,
        green_f: f32,
        blue_f: f32,
        output_pixel: *mut u8,
        matrix: &[f32; 25],
    ) {
        let mut current_result = 0.0;

        // 处理 RGB 变换
        current_result += matrix[channel_index * 5 + 0] * red_f; // 注意 current_output 未初始化
        current_result += matrix[channel_index * 5 + 1] * green_f;
        current_result += matrix[channel_index * 5 + 2] * blue_f;

        // 第5行提供平移（相加）操作：直接加上第5行对应的值
        current_result += matrix[4 * 5 + channel_index];

        unsafe {
            output_pixel
                .add(channel_index)
                .write(if current_result > 1.0 {
                    255
                } else if current_result < 0.0 {
                    0
                } else {
                    (current_result * 255.0) as u8
                });
        }
    }

    /// 应用 5x5 颜色变换矩阵到 RGB 像素
    fn apply_color_matrix(pixel: *const u8, output_pixel: *mut u8, matrix: &[f32; 25]) {
        let (red_f, green_f, blue_f) = unsafe {
            (
                *pixel.add(0) as f32 / 255.0,
                *pixel.add(1) as f32 / 255.0,
                *pixel.add(2) as f32 / 255.0,
            )
        };

        // 前 3 行：矩阵乘法计算 RGB 变换（不处理 alpha 通道）
        Self::apply_color_matrix_to_channel(0, red_f, green_f, blue_f, output_pixel, matrix);
        Self::apply_color_matrix_to_channel(1, red_f, green_f, blue_f, output_pixel, matrix);
        Self::apply_color_matrix_to_channel(2, red_f, green_f, blue_f, output_pixel, matrix);
    }

    /// 将颜色矩阵应用到整个图像
    fn apply_color_effect_to_image(
        image: &mut DynamicImage,
        matrix: &[f32; 25],
        color_format: ColorFormat,
    ) -> Result<(), String> {
        let (width, height) = image.dimensions();

        let (pixel_len, image_raw_ptr) = match color_format {
            ColorFormat::Rgba8 => (4, image.as_mut_rgba8().unwrap().as_mut_ptr()),
            ColorFormat::Rgb8 => (3, image.as_mut_rgb8().unwrap().as_mut_ptr()),
        };

        let image_raw_ptr = image_raw_ptr as usize;
        let output_data_ptr = image_raw_ptr as usize;

        let pixel_count = (width * height) as usize;

        (0..pixel_count).into_par_iter().for_each(|pixel_index| {
            let index = pixel_index * pixel_len;
            unsafe {
                Self::apply_color_matrix(
                    (image_raw_ptr as *const u8).add(index),
                    (output_data_ptr as *mut u8).add(index),
                    matrix,
                );
            }
        });

        Ok(())
    }

    fn invert_color_matrix(matrix: &[f32; 25]) -> Result<[f32; 25], String> {
        /// 计算 3x3 矩阵的行列式
        #[inline(always)]
        fn determinant_3x3(m: &[[f32; 3]; 3]) -> f32 {
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
        }

        /// 计算 3x3 矩阵的逆矩阵（优化版）
        #[inline(always)]
        fn invert_3x3_matrix(m: &[[f32; 3]; 3]) -> Option<[[f32; 3]; 3]> {
            let det = determinant_3x3(m);
            if det.abs() < f32::EPSILON * 100.0 {
                return None;
            }

            let inv_det = 1.0 / det;

            // 使用伴随矩阵公式，但优化计算顺序减少重复访问
            let m00 = m[0][0];
            let m01 = m[0][1];
            let m02 = m[0][2];
            let m10 = m[1][0];
            let m11 = m[1][1];
            let m12 = m[1][2];
            let m20 = m[2][0];
            let m21 = m[2][1];
            let m22 = m[2][2];

            // 预计算中间值以减少重复计算
            let c00 = m11 * m22 - m12 * m21;
            let c01 = m12 * m20 - m10 * m22;
            let c02 = m10 * m21 - m11 * m20;

            let c10 = m02 * m21 - m01 * m22;
            let c11 = m00 * m22 - m02 * m20;
            let c12 = m01 * m20 - m00 * m21;

            let c20 = m01 * m12 - m02 * m11;
            let c21 = m02 * m10 - m00 * m12;
            let c22 = m00 * m11 - m01 * m10;

            Some([
                [c00 * inv_det, c01 * inv_det, c02 * inv_det],
                [c10 * inv_det, c11 * inv_det, c12 * inv_det],
                [c20 * inv_det, c21 * inv_det, c22 * inv_det],
            ])
        }

        /// 计算矩阵-向量乘法：result = -matrix * vector
        #[inline(always)]
        fn matrix_vector_mul_neg(matrix: &[[f32; 3]; 3], vector: [f32; 3]) -> [f32; 3] {
            [
                -(matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2]),
                -(matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2]),
                -(matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2]),
            ]
        }

        // 直接提取 3x3 线性变换矩阵和 3x1 平移向量
        let linear_matrix = [
            [matrix[0], matrix[1], matrix[2]],    // R 行
            [matrix[5], matrix[6], matrix[7]],    // G 行
            [matrix[10], matrix[11], matrix[12]], // B 行
        ];
        let translation = [matrix[20], matrix[21], matrix[22]]; // RGB 平移

        // 计算线性变换的逆矩阵
        let inv_linear = invert_3x3_matrix(&linear_matrix).ok_or(
            "[MonitorInfoList::invert_color_matrix] linear_matrix is not invertible".to_string(),
        )?;

        // 计算逆平移向量
        let inv_translation = matrix_vector_mul_neg(&inv_linear, translation);

        // 构建反转的 5x5 矩阵
        let mut inverted_matrix = [0.0f32; 25];

        // RGB 变换行（直接映射到正确的索引位置）
        inverted_matrix[0] = inv_linear[0][0];
        inverted_matrix[1] = inv_linear[0][1];
        inverted_matrix[2] = inv_linear[0][2];

        inverted_matrix[5] = inv_linear[1][0];
        inverted_matrix[6] = inv_linear[1][1];
        inverted_matrix[7] = inv_linear[1][2];

        inverted_matrix[10] = inv_linear[2][0];
        inverted_matrix[11] = inv_linear[2][1];
        inverted_matrix[12] = inv_linear[2][2];

        // Alpha 通道保持单位变换：[0, 0, 0, 1, 0]
        inverted_matrix[15] = 0.0; // Alpha R
        inverted_matrix[16] = 0.0; // Alpha G
        inverted_matrix[17] = 0.0; // Alpha B
        inverted_matrix[18] = 1.0; // Alpha A
        inverted_matrix[19] = 0.0; // Alpha 偏移

        // 平移行
        inverted_matrix[20] = inv_translation[0]; // R 偏移
        inverted_matrix[21] = inv_translation[1]; // G 偏移
        inverted_matrix[22] = inv_translation[2]; // B 偏移
        inverted_matrix[23] = 0.0; // A 偏移

        // 最后一行：[0, 0, 0, 0, 1] 用于仿射变换
        inverted_matrix[24] = 1.0;

        Ok(inverted_matrix)
    }

    /**
     * 获取 Windows 下放大镜的反转颜色变换矩阵
     * 用于还原被放大镜颜色效果影响的图像
     */
    pub async fn get_mag_color_effect_inverse(
        correct_color_filter: bool,
    ) -> Result<Option<[f32; 25]>, String> {
        if !correct_color_filter {
            return Ok(None);
        }

        match Self::get_mag_color_effect().await? {
            Some(matrix) => {
                let inverted = Self::invert_color_matrix(&matrix)?;
                Ok(Some(inverted))
            }
            None => Ok(None),
        }
    }

    /**
     * 获取 Windows 下放大镜的颜色变换举证
     */
    async fn get_mag_color_effect() -> Result<Option<[f32; 25]>, String> {
        #[cfg(not(target_os = "windows"))]
        {
            return Ok(None);
        }

        #[cfg(target_os = "windows")]
        {
            let init_result = unsafe { windows::Win32::UI::Magnification::MagInitialize() };
            if !init_result.as_bool() {
                log::warn!(
                    "[MonitorInfoList::get_mag_color_effect] Failed to initialize magnification library"
                );
                return Ok(None);
            }

            let mut current_effect = windows::Win32::UI::Magnification::MAGCOLOREFFECT::default();
            let get_effect_result = unsafe {
                windows::Win32::UI::Magnification::MagGetFullscreenColorEffect(&mut current_effect)
            };

            // 释放 Mag
            let uninit_result = unsafe { windows::Win32::UI::Magnification::MagUninitialize() };
            if !uninit_result.as_bool() {
                log::warn!(
                    "[MonitorInfoList::get_mag_color_effect] Failed to uninitialize magnification library"
                );
            }

            if !get_effect_result.as_bool() {
                log::warn!(
                    "[MonitorInfoList::get_mag_color_effect] Failed to get magnification color effect"
                );
                return Ok(None);
            }

            let matrix = current_effect.transform;
            // 无任何效果的默认矩阵
            const NORMAL_MATRIX: [f32; 25] = [
                1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ];
            // 判断 matrix 是否等于 NORMAL_MATRIX
            if matrix.eq(&NORMAL_MATRIX) {
                return Ok(None);
            }

            Ok(Some(matrix))
        }
    }

    async fn capture_core(
        &self,
        crop_region: Option<ElementRect>,
        exclude_window: Option<&tauri::Window>,
        capture_option: CaptureOption,
    ) -> Result<image::DynamicImage, String> {
        let enable_exclude_window = {
            #[cfg(target_os = "windows")]
            {
                capture_option.correct_hdr_color_algorithm != CorrectHdrColorAlgorithm::None
                    && self
                        .0
                        .iter()
                        .any(|monitor| monitor.monitor_hdr_info.hdr_enabled)
            }

            #[cfg(target_os = "macos")]
            {
                false
            }
        };

        // 如果启用了 HDR，并且显示器开启了 HDR 信息
        let mut need_reset_exclude_window = false;
        if enable_exclude_window {
            if let Some(exclude_window) = exclude_window {
                match crate::set_exclude_from_capture(exclude_window, true).await {
                    Ok(_) => {
                        need_reset_exclude_window = true;
                    }
                    Err(e) => {
                        return Err(format!(
                            "[MonitorInfoList::capture_core] failed to set exclude from capture: {:?}",
                            e
                        ));
                    }
                }
            }
        }

        let result = tokio::try_join!(
            self.capture_future(crop_region, exclude_window, capture_option,),
            Self::get_mag_color_effect_inverse(capture_option.correct_color_filter)
        );

        if need_reset_exclude_window {
            if let Some(exclude_window) = exclude_window {
                match crate::set_exclude_from_capture(exclude_window, false).await {
                    Ok(_) => (),
                    Err(e) => {
                        return Err(format!(
                            "[MonitorInfoList::capture_core] failed to reset exclude from capture: {:?}",
                            e
                        ));
                    }
                }
            }
        }

        match result {
            Ok((mut image, color_effect)) => {
                let image = match color_effect {
                    Some(matrix) => {
                        Self::apply_color_effect_to_image(
                            &mut image,
                            &matrix,
                            capture_option.color_format,
                        )?;

                        image
                    }
                    None => image,
                };

                Ok(image)
            }
            Err(e) => {
                log::error!("[MonitorInfoList::capture_core] failed to capture: {:?}", e);
                Err(e)
            }
        }
    }

    pub async fn capture(
        &self,
        exclude_window: Option<&tauri::Window>,
        capture_option: CaptureOption,
    ) -> Result<image::DynamicImage, String> {
        self.capture_core(None, exclude_window, capture_option)
            .await
    }

    pub async fn capture_region(
        &self,
        region: ElementRect,
        exclude_window: Option<&tauri::Window>,
        capture_option: CaptureOption,
    ) -> Result<image::DynamicImage, String> {
        self.capture_core(Some(region), exclude_window, capture_option)
            .await
    }

    pub fn monitor_rect_list(&self) -> Vec<MonitorRect> {
        self.0
            .iter()
            .map(|monitor| MonitorRect {
                rect: monitor.rect,
                scale_factor: monitor.scale_factor,
            })
            .collect()
    }

    pub fn iter(&self) -> impl Iterator<Item = &MonitorInfo> {
        self.0.iter()
    }
}

#[cfg(test)]
mod tests {
    use std::env;

    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn test_get_all_monitors() {
        use crate::monitor_hdr_info;

        let monitors = MonitorList::all(true);
        println!("monitors: {:?}", monitors);

        let monitor_hdr_info_map = monitor_hdr_info::get_all_monitors_sdr_info().unwrap();
        println!("monitor_hdr_info_map: {:?}", monitor_hdr_info_map);

        for monitor in monitors.iter() {
            println!(
                "monitor: {:?}",
                MonitorInfo::get_device_name(&monitor.monitor).unwrap()
            );
            println!(
                "monitor_hdr_info: {:?}",
                monitor_hdr_info_map
                    .get(
                        MonitorInfo::get_device_name(&monitor.monitor)
                            .unwrap()
                            .as_str()
                    )
                    .unwrap()
            );
        }
    }

    #[tokio::test]
    async fn test_capture_multi_monitor() {
        let instance = std::time::Instant::now();

        let crop_region: ElementRect;
        #[cfg(target_os = "windows")]
        {
            crop_region = ElementRect {
                min_x: -3840,
                min_y: 0,
                max_x: 3840,
                max_y: 2160,
            };
        }
        #[cfg(target_os = "macos")]
        {
            crop_region = ElementRect {
                min_x: 0,
                min_y: 0,
                max_x: 7680,
                max_y: 2160,
            };
        }

        let monitors = MonitorList::get_by_region(crop_region, true);

        let image = monitors
            .capture(
                None,
                CaptureOption {
                    color_format: ColorFormat::Rgb8,
                    correct_hdr_color_algorithm: CorrectHdrColorAlgorithm::None,
                    correct_color_filter: false,
                },
            )
            .await
            .unwrap();

        println!("current_dir: {:?}", env::current_dir().unwrap());

        image
            .save(
                std::path::PathBuf::from(env::current_dir().unwrap())
                    .join("../../test_output/capture_multi_monitor.webp"),
            )
            .unwrap();

        println!("time: {:?}", instance.elapsed());
    }

    #[test]
    fn test_invert_color_matrix() {
        // 测试单位矩阵的反转
        let identity: [f32; 25] = [
            1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];

        let inverted = MonitorList::invert_color_matrix(&identity).unwrap();
        assert_eq!(inverted, identity);

        // 测试简单的缩放矩阵
        let scale_matrix: [f32; 25] = [
            2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];

        let inverted_scale = MonitorList::invert_color_matrix(&scale_matrix).unwrap();
        let expected_scale: [f32; 25] = [
            0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];

        for (i, (&actual, &expected)) in
            inverted_scale.iter().zip(expected_scale.iter()).enumerate()
        {
            assert!(
                (actual - expected).abs() < 1e-6,
                "Index {}: {} != {}",
                i,
                actual,
                expected
            );
        }

        // 测试带平移的矩阵
        let translate_matrix: [f32; 25] = [
            1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.1, 0.2, 0.3, 0.0, 1.0,
        ];

        let inverted_translate = MonitorList::invert_color_matrix(&translate_matrix).unwrap();
        let expected_translate: [f32; 25] = [
            1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, -0.1, -0.2, -0.3, 0.0, 1.0,
        ];

        for (i, (&actual, &expected)) in inverted_translate
            .iter()
            .zip(expected_translate.iter())
            .enumerate()
        {
            assert!(
                (actual - expected).abs() < 1e-6,
                "Index {}: {} != {}",
                i,
                actual,
                expected
            );
        }
    }

    #[tokio::test]
    async fn test_capture_single_monitor() {
        let instance = std::time::Instant::now();

        let crop_region = ElementRect {
            min_x: 0,
            min_y: 0,
            max_x: 1000,
            max_y: 1000,
        };

        let monitors = MonitorList::get_by_region(crop_region, true);
        let image = monitors
            .capture_region(
                crop_region,
                None,
                CaptureOption {
                    color_format: ColorFormat::Rgb8,
                    correct_hdr_color_algorithm: CorrectHdrColorAlgorithm::None,
                    correct_color_filter: false,
                },
            )
            .await
            .unwrap();

        image
            .save(
                std::path::PathBuf::from(env::current_dir().unwrap())
                    .join("../../test_output/capture_single_monitor.webp"),
            )
            .unwrap();

        println!("time: {:?}", instance.elapsed());
    }
}
