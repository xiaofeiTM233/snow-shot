use ffmpeg_sidecar::{child::FfmpegChild, command::FfmpegCommand, event::FfmpegEvent};
use regex::Regex;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use snow_shot_app_utils::monitor_info::MonitorInfo;
#[cfg(target_os = "macos")]
use snow_shot_app_utils::monitor_info::MonitorList;
use std::{
    io::Result,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::video_record_capture::{
    PinrayFeed, PinrayFeedParams, RecordPixelFormat, SystemAudioMeta, VideoCaptureBackend,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Copy)]
pub enum VideoRecordState {
    Idle,
    Recording,
    Paused,
}

/// 根据预设值获取基于CRF/global_quality参数的编码器质量值
/// 适用于AV1、VP9、H264_QSV等使用global_quality参数的编码器
///
/// # 参数
/// * `preset` - 编码器预设值
///
/// # 返回
/// global_quality参数值 (0-51, **值越小质量越高**)
///
/// # 质量说明
/// * 18: 高质量（压缩率低），慢速编码
/// * 22: 平衡质量
/// * 28: 低质量（压缩率高），快速编码
fn get_global_quality(preset: &str) -> i32 {
    match preset {
        "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" => 28,
        "medium" => 22,
        "slow" | "slower" => 18,
        "veryslow" | "placebo" => 16,
        _ => 22,
    }
}

/// 根据预设值获取MPEG4编码器的qscale值
///
/// # 参数
/// * `preset` - 编码器预设值
///
/// # 返回
/// qscale参数值 (1-31, **值越小质量越高**)
///
/// # 质量说明
/// * 4: 较高质量（压缩率较低），默认平衡值
/// * 5: 中等质量
/// * 6: 较低质量（压缩率较高）
/// * 7: 低质量（压缩率很高）
fn get_mpeg4_quality(preset: &str) -> i32 {
    match preset {
        "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" => 4,
        "medium" => 5,
        "slow" | "slower" => 6,
        "veryslow" | "placebo" => 7,
        _ => 4,
    }
}

/// 根据预设值获取ProRes编码器的profile值
///
/// # 参数
/// * `preset` - 编码器预设值
///
/// # 返回
/// profile参数值 (0-3)
///
/// # Profile说明 (FFmpeg prores编码器)
/// * 0: Proxy (最低质量,最高压缩率)
/// * 1: LT (低质量,中高压缩率)
/// * 2: Standard (默认,平衡)
/// * 3: Normal (高质量,低压缩率)
fn get_prores_quality(preset: &str) -> i32 {
    match preset {
        "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" => 0,
        "medium" => 1,
        "slow" | "slower" => 2,
        "veryslow" | "placebo" => 3,
        _ => 2,
    }
}

#[derive(PartialEq, Serialize, Deserialize, Debug, Clone, Copy)]
pub enum VideoFormat {
    Mp4,
    Mkv,
    Mov,
    Gif,
}

impl VideoFormat {
    pub fn extension(&self) -> &str {
        match self {
            VideoFormat::Mp4 => "mp4",
            VideoFormat::Mkv => "mkv",
            VideoFormat::Mov => "mov",
            VideoFormat::Gif => "gif",
        }
    }

    /// `-movflags +faststart` 仅对 MP4/MOV 容器有意义（MKV 无此选项）
    pub fn supports_faststart(&self) -> bool {
        matches!(self, VideoFormat::Mp4 | VideoFormat::Mov)
    }
}

// 录制参数结构体，用于在暂停后恢复录制时重用参数
#[derive(Clone, Debug)]
struct RecordingParams {
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
    output_file: String,
    format: VideoFormat,
    frame_rate: u32,
    enable_microphone: bool,
    enable_system_audio: bool,
    microphone_device_name: String,
    hwaccel: bool,
    encoder: String,
    encoder_preset: String,
    video_max_width: i32,
    video_max_height: i32,
    /// 视频采集后端（pinray / 传统 gdigrab/avfoundation）
    capture_backend: VideoCaptureBackend,
    /// 采集像素格式（仅 pinray 后端生效）
    pixel_format: RecordPixelFormat,
    /// 是否把鼠标指针合成进画面（三种后端均生效）
    capture_cursor: bool,
}

pub struct VideoRecordService {
    pub state: VideoRecordState,
    pub child: Option<FfmpegChild>,
    // 片段管理相关字段
    segments: Vec<String>,                     // 存储所有片段文件路径
    segment_counter: u32,                      // 片段计数器
    recording_params: Option<RecordingParams>, // 录制参数，用于恢复录制
    record_video_size: Option<(i32, i32)>,     // 录制视频大小
    ffmpeg_path: Option<PathBuf>,
    // pinray 采集后端相关字段
    pinray_feed: Option<PinrayFeed>, // pinray 采集会话（每片段一个）
    mic_child: Option<FfmpegChild>,  // pinray 模式下独立采集麦克风的 ffmpeg 子进程
    mic_audio_segments: Vec<String>, // pinray 模式下各片段麦克风 raw PCM 文件
    sys_audio_segments: Vec<String>, // pinray 模式下各片段系统声音 raw PCM 文件
    sys_audio_meta: Option<SystemAudioMeta>, // 系统声音元信息（来自首个音频帧）
    mic_device_names_cache: Option<Vec<String>>, // 麦克风设备列表缓存（dshow 枚举耗时 1~3s，避免每次启动录制都枚举）
}

#[cfg(target_os = "macos")]
#[derive(PartialEq, Serialize, Deserialize, Debug, Clone, Copy)]
pub enum DeviceType {
    Audio,
    Video,
}

#[cfg(target_os = "macos")]
#[derive(PartialEq, Serialize, Deserialize, Debug, Clone)]
pub struct DeviceInfo {
    pub name: String,
    pub index: usize,
    pub device_type: DeviceType,
}

impl VideoRecordService {
    pub fn new() -> Self {
        Self {
            state: VideoRecordState::Idle,
            child: None,
            segments: Vec::new(),
            segment_counter: 0,
            recording_params: None,
            record_video_size: None,
            ffmpeg_path: None,
            pinray_feed: None,
            mic_child: None,
            mic_audio_segments: Vec::new(),
            sys_audio_segments: Vec::new(),
            sys_audio_meta: None,
            mic_device_names_cache: None,
        }
    }

    pub fn init(&mut self, ffmpeg_plugin_dir: &Path) {
        if self.ffmpeg_path.is_none() {
            #[cfg(target_os = "windows")]
            {
                self.ffmpeg_path = Some(ffmpeg_plugin_dir.join("ffmpeg.exe"));
            }

            #[cfg(target_os = "macos")]
            {
                use std::fs;
                use std::os::unix::fs::PermissionsExt;

                let ffmpeg_path = ffmpeg_plugin_dir.join("ffmpeg");

                // 为 ffmpeg 文件添加可执行权限
                if ffmpeg_path.exists() {
                    if let Ok(metadata) = fs::metadata(&ffmpeg_path) {
                        let mut permissions = metadata.permissions();
                        permissions.set_mode(0o755); // 设置可执行权限 (rwxr-xr-x)

                        if let Err(e) = fs::set_permissions(&ffmpeg_path, permissions) {
                            eprintln!(
                                "[VideoRecordService] Failed to set executable permissions for ffmpeg: {}",
                                e
                            );
                        } else {
                            println!(
                                "[VideoRecordService] Successfully set executable permissions for ffmpeg"
                            );
                        }
                    }
                }

                self.ffmpeg_path = Some(ffmpeg_path);
            }
        }
    }

    pub fn get_ffmpeg_command(&self) -> FfmpegCommand {
        FfmpegCommand::new_with_path(
            self.ffmpeg_path
                .as_ref()
                .expect("[VideoRecordService] valid ffmpeg path"),
        )
    }

    fn get_actual_video_size(
        &self,
        width: i32,
        height: i32,
        video_max_width: i32,
        video_max_height: i32,
    ) -> (i32, i32) {
        if width > video_max_width || height > video_max_height {
            // 计算保持宽高比的最大尺寸
            let max_width = video_max_width;
            let max_height = video_max_height;

            let scale_x = max_width as f64 / width as f64;
            let scale_y = max_height as f64 / height as f64;

            let target_size_scale = scale_x.min(scale_y);

            let mut target_width = (width as f64 * target_size_scale) as i32;
            let mut target_height = (height as f64 * target_size_scale) as i32;

            if target_width % 2 == 1 {
                target_width -= 1;
            }
            if target_height % 2 == 1 {
                target_height -= 1;
            }

            (target_width, target_height)
        } else {
            (width, height)
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &mut self,
        min_x: i32,
        min_y: i32,
        max_x: i32,
        max_y: i32,
        output_file: String,
        format: VideoFormat,
        frame_rate: u32,
        enable_microphone: bool,
        enable_system_audio: bool,
        microphone_device_name: String,
        hwaccel: bool,
        encoder: String,
        encoder_preset: String,
        video_max_width: i32,
        video_max_height: i32,
        capture_backend: VideoCaptureBackend,
        pixel_format: RecordPixelFormat,
        capture_cursor: bool,
    ) -> Result<()> {
        if self.state == VideoRecordState::Recording {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "Recording is already in progress",
            ));
        }

        // 保存录制参数
        self.recording_params = Some(RecordingParams {
            min_x,
            min_y,
            max_x,
            max_y,
            output_file: output_file.clone(),
            format,
            frame_rate,
            enable_microphone,
            enable_system_audio,
            microphone_device_name,
            hwaccel,
            encoder,
            encoder_preset,
            video_max_width,
            video_max_height,
            capture_backend,
            pixel_format,
            capture_cursor,
        });

        // 重置片段相关状态
        self.segments.clear();
        self.segment_counter = 0;
        self.record_video_size = None;
        self.mic_audio_segments.clear();
        self.sys_audio_segments.clear();
        self.sys_audio_meta = None;

        // 开始第一个片段的录制
        self.start_segment()
    }

    fn start_segment(&mut self) -> Result<()> {
        let params = self.recording_params.as_ref().unwrap();

        if params.capture_backend != VideoCaptureBackend::Legacy {
            return self.start_pinray_segment();
        }

        // 克隆持有：函数体内需要 &mut self（麦克风设备枚举会刷新缓存）
        let params = self.recording_params.clone().unwrap();

        // 计算录制区域的宽度和高度
        let mut width = params.max_x - params.min_x;
        let mut height = params.max_y - params.min_y;

        if width <= 0 || height <= 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Invalid recording area dimensions",
            ));
        }

        // 确保宽度和高度都是偶数（libx264要求）
        if width % 2 == 1 {
            width -= 1;
        }
        if height % 2 == 1 {
            height -= 1;
        }

        println!(
            "Recording segment {} area: {}x{} at ({}, {})",
            self.segment_counter + 1,
            width,
            height,
            params.min_x,
            params.min_y
        );

        let mut command = self.get_ffmpeg_command();

        // 硬件加速选项必须在输入选项之前
        if params.hwaccel {
            command.arg("-hwaccel").arg("auto");
        }

        // 根据平台设置不同的输入格式
        #[cfg(target_os = "windows")]
        {
            // Windows 使用 gdigrab
            command
                .arg("-f")
                .arg("gdigrab")
                .arg("-framerate")
                .arg(params.frame_rate.to_string())
                // 设置偏移量
                .arg("-offset_x")
                .arg(params.min_x.to_string())
                .arg("-offset_y")
                .arg(params.min_y.to_string())
                // 设置录制区域大小
                .arg("-video_size")
                .arg(format!("{}x{}", width, height))
                // 鼠标指针按用户设置绘制（gdigrab 默认绘制）
                .arg("-draw_mouse")
                .arg(if params.capture_cursor { "1" } else { "0" })
                // 输入源为桌面
                .arg("-i")
                .arg("desktop");
        }

        #[cfg(target_os = "macos")]
        {
            // macOS 使用 avfoundation
            command
                .arg("-f")
                .arg("avfoundation")
                .arg("-framerate")
                .arg(params.frame_rate.to_string())
                // 鼠标指针按用户设置采集
                .arg("-capture_cursor")
                .arg(if params.capture_cursor { "1" } else { "0" });
        }

        let mut audio_input = String::new();

        // 根据平台添加音频输入
        #[cfg(target_os = "windows")]
        {
            // 添加系统音频输入
            if params.enable_system_audio {
                // command
                //     .arg("-f")
                //     .arg("dshow")
                //     .arg("-i")
                //     .arg("audio=virtual-audio-capturer");
                // audio_inputs.push("1:a".to_string());
            }

            // 添加麦克风音频输入
            if params.enable_microphone {
                let device_names = self.get_microphone_device_names();

                if device_names.len() > 0 {
                    command.arg("-f").arg("dshow").arg("-i").arg(format!(
                        "audio={}",
                        if device_names.contains(&params.microphone_device_name) {
                            params.microphone_device_name.clone()
                        } else {
                            device_names[0].clone()
                        }
                    ));
                    audio_input = format!("{}:a", 1);
                }
            }
        }

        #[cfg(target_os = "macos")]
        let monitor_list = MonitorList::all(true);
        #[cfg(target_os = "macos")]
        let mut target_monitor_index = 0;

        // macOS 音频输入处理
        #[cfg(target_os = "macos")]
        {
            let device_info_list = self.get_device_info_list();

            let audio_device = if params.enable_microphone {
                device_info_list.iter().find(|d| {
                    d.device_type == DeviceType::Audio
                        && Self::format_device_name(d) == params.microphone_device_name
                })
            } else {
                None
            };

            // 没有找到对应的显示器，回退到默认显示器
            for (monitor_index, monitor) in monitor_list.iter().enumerate() {
                use snow_shot_app_shared::ElementRect;

                if monitor.rect.overlaps(&ElementRect {
                    min_x: params.min_x,
                    min_y: params.min_y,
                    max_x: params.max_x,
                    max_y: params.max_y,
                }) {
                    target_monitor_index = monitor_index;
                    break;
                }
            }

            // 判断是否存在对应的显示器
            if !device_info_list.iter().any(|d| {
                d.device_type == DeviceType::Video
                    && d.name == format!("Capture screen {}", target_monitor_index)
            }) {
                target_monitor_index = 0;
                log::warn!(
                    "[video_record_service::start_segment] No corresponding display found for microphone device: {}",
                    params.microphone_device_name
                );
            }

            if let Some(audio_device) = audio_device {
                // 格式: -f avfoundation -i "0:设备索引"
                command
                    .arg("-i")
                    .arg(format!("{}:{}", target_monitor_index, audio_device.index));
                audio_input = format!("{}:a", audio_device.index);
            } else {
                command.arg("-i").arg(format!("{}", target_monitor_index));
            }
        }

        // 生成当前片段的文件名
        let segment_filename = format!(
            "{}_segment_{:03}.{}",
            params.output_file,
            self.segment_counter,
            params.format.extension()
        );

        // 确保输出文件的目录存在
        if let Some(parent_dir) = std::path::Path::new(&segment_filename).parent() {
            if let Err(e) = std::fs::create_dir_all(parent_dir) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to create output directory: {}", e),
                ));
            }
        }

        let mut video_filter = String::new();
        let (target_width, target_height) = self.get_actual_video_size(
            width,
            height,
            params.video_max_width,
            params.video_max_height,
        );
        if target_width != width || target_height != height {
            video_filter = format!("scale={}:{}:flags=lanczos", target_width, target_height);
            println!(
                "Scaling video from {}x{} to {}x{}",
                width, height, target_width, target_height
            );
        }
        self.record_video_size = Some((target_width, target_height));

        // 根据格式设置不同的参数
        match params.format {
            VideoFormat::Mp4 | VideoFormat::Mkv | VideoFormat::Mov => {
                Self::apply_encoder_preset(&mut command, &params.encoder, &params.encoder_preset);

                #[cfg(target_os = "windows")]
                {
                    if !video_filter.is_empty() {
                        command.arg("-vf").arg(&video_filter);
                    }

                    command.arg("-crf").arg("23").arg("-pix_fmt").arg("yuv420p"); // 添加像素格式，确保兼容性
                }

                #[cfg(target_os = "macos")]
                {
                    let target_monitor_rect =
                        if let Some(monitor) = monitor_list.iter().nth(target_monitor_index) {
                            monitor.rect
                        } else {
                            snow_shot_app_shared::ElementRect {
                                min_x: 0,
                                min_y: 0,
                                max_x: 0,
                                max_y: 0,
                            }
                        };

                    let crop_filter = format!(
                        "crop={}:{}:{}:{}",
                        width,
                        height,
                        (params.min_x - target_monitor_rect.min_x),
                        (params.min_y - target_monitor_rect.min_y)
                    );

                    // 组合 video_filter 和 crop_filter
                    let final_filter = if !video_filter.is_empty() {
                        format!("{},{}", crop_filter, video_filter)
                    } else {
                        crop_filter
                    };

                    command.arg("-vf").arg(final_filter);
                    command.arg("-crf").arg("23").arg("-pix_fmt").arg("uyvy422"); // 添加像素格式，确保兼容性
                }

                // 音频编码设置
                if !audio_input.is_empty() {
                    command.arg("-c:a").arg("aac").arg("-b:a").arg("128k");

                    // 音频处理，添加降噪
                    let filter_complex =
                        format!("[{}]anlmdn=s=10:p=0.001:r=0.005[aout]", audio_input);
                    command.arg("-filter_complex").arg(filter_complex);
                    command.arg("-map").arg("0:v").arg("-map").arg("[aout]");
                } else {
                    // 没有音频输入时，只映射视频
                    command.arg("-map").arg("0:v");
                }

                if params.format.supports_faststart() {
                    command.arg("-movflags").arg("+faststart"); // 优化MP4文件结构
                }
            }
            VideoFormat::Gif => {
                // GIF格式不包含音频
                command
                    .arg("-vf")
                    .arg("fps=10,scale=-1:-1:flags=lanczos,palettegen=reserve_transparent=0")
                    .arg("-loop")
                    .arg("0");
            }
        }

        command.arg("-y");

        // 输出文件
        command.arg(&segment_filename);

        println!("FFmpeg segment command args: {:?}", command);

        // 启动ffmpeg进程
        match command.spawn() {
            Ok(mut child) => {
                for event in child.iter().unwrap() {
                    if params.format == VideoFormat::Mp4 {
                        match event {
                            FfmpegEvent::Progress(_) => {
                                self.child = Some(child);
                                self.state = VideoRecordState::Recording;
                                self.segments.push(segment_filename);
                                self.segment_counter += 1;
                                return Ok(());
                            }
                            _ => {}
                        }
                    }
                }

                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "Failed to start recording segment",
                ))
            }
            Err(e) => {
                self.state = VideoRecordState::Idle;
                println!("FFmpeg start error: {}", e);
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to start recording segment: {}", e),
                ))
            }
        }
    }

    /// pinray 采集后端的片段录制：
    /// ffmpeg 主进程仅接收 rawvideo stdin 视频（编码参数与 legacy 一致）；
    /// 视频帧由 pinray 采集线程写入；系统声音由采集线程写 raw PCM、
    /// 麦克风由独立 ffmpeg 进程写 raw PCM，停止时统一 mux（见 mux_pinray_audio）。
    /// 不使用 in-process dshow/avfoundation 音频输入——否则视频 stdin EOF 后
    /// ffmpeg 会因音频输入仍在直播而无法退出。
    fn start_pinray_segment(&mut self) -> Result<()> {
        let params = self.recording_params.clone().unwrap();

        // 1. 解析采集目标显示器与裁剪区域
        let (source_id, crop, width, height, _monitor_info) =
            Self::resolve_pinray_target(&params)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;

        let mut command = self.get_ffmpeg_command();

        // rawvideo stdin 输入（采集线程写入，帧率节拍由采集线程保证）
        command
            .arg("-f")
            .arg("rawvideo")
            .arg("-pix_fmt")
            .arg(params.pixel_format.ffmpeg_pix_fmt())
            .arg("-video_size")
            .arg(format!("{}x{}", width, height))
            .arg("-framerate")
            .arg(params.frame_rate.to_string())
            .arg("-i")
            .arg("pipe:0");

        // 生成当前片段的文件名
        let segment_filename = format!(
            "{}_segment_{:03}.{}",
            params.output_file,
            self.segment_counter,
            params.format.extension()
        );

        // 确保输出文件的目录存在
        if let Some(parent_dir) = std::path::Path::new(&segment_filename).parent() {
            if let Err(e) = std::fs::create_dir_all(parent_dir) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to create output directory: {}", e),
                ));
            }
        }

        let mut video_filter = String::new();
        let (target_width, target_height) = self.get_actual_video_size(
            width,
            height,
            params.video_max_width,
            params.video_max_height,
        );
        if target_width != width || target_height != height {
            video_filter = format!("scale={}:{}:flags=lanczos", target_width, target_height);
        }
        self.record_video_size = Some((target_width, target_height));

        // 根据格式设置输出参数（音频由停止时 mux，不在本进程内）
        match params.format {
            VideoFormat::Mp4 | VideoFormat::Mkv | VideoFormat::Mov => {
                Self::apply_encoder_preset(&mut command, &params.encoder, &params.encoder_preset);
                if !video_filter.is_empty() {
                    command.arg("-vf").arg(&video_filter);
                }
                command.arg("-crf").arg("23").arg("-pix_fmt").arg("yuv420p");
                if params.format.supports_faststart() {
                    command.arg("-movflags").arg("+faststart");
                }
            }
            VideoFormat::Gif => {
                command
                    .arg("-vf")
                    .arg("fps=10,scale=-1:-1:flags=lanczos,palettegen=reserve_transparent=0")
                    .arg("-loop")
                    .arg("0");
            }
        }

        command.arg("-y");
        command.arg(&segment_filename);

        println!("FFmpeg pinray segment command args: {:?}", command);

        // 2. 启动 ffmpeg
        let mut child = command.spawn().map_err(|e| {
            self.state = VideoRecordState::Idle;
            std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to start recording segment: {}", e),
            )
        })?;

        let stdin = child.take_stdin().ok_or_else(|| {
            self.state = VideoRecordState::Idle;
            std::io::Error::new(std::io::ErrorKind::Other, "Failed to take ffmpeg stdin")
        })?;

        // 3. 麦克风：独立 ffmpeg 进程录制 raw PCM（GIF 格式不含音频）
        let mut mic_started = false;
        if params.format == VideoFormat::Mp4 && params.enable_microphone {
            mic_started = self.spawn_pinray_mic_recorder(&params).is_ok();
        }

        // 4. 启动采集线程（等待会话建立握手）
        let enable_system_audio = params.format == VideoFormat::Mp4 && params.enable_system_audio;
        let audio_raw_path = format!(
            "{}_segment_{:03}_sys.raw",
            params.output_file, self.segment_counter
        );
        let feed = match PinrayFeed::start(
            PinrayFeedParams {
                source_id,
                crop,
                frame_rate: params.frame_rate,
                pixel_format: params.pixel_format,
                capture_cursor: params.capture_cursor,
                enable_system_audio,
                audio_raw_path: PathBuf::from(&audio_raw_path),
            },
            stdin,
        ) {
            Ok(feed) => feed,
            Err(e) => {
                if mic_started {
                    if let Some(mut mic_child) = self.mic_child.take() {
                        let _ = mic_child.kill();
                    }
                    self.mic_audio_segments.clear();
                }
                let _ = child.kill();
                self.state = VideoRecordState::Idle;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to start pinray feed: {}", e),
                ));
            }
        };
        self.pinray_feed = Some(feed);

        // 5. 握手（Started）意味着首个视频帧已成功写入 ffmpeg——录制内容起点
        //    就是此刻，立即进入 Recording 状态并返回，让前端计时与内容对齐。
        //    （不再阻塞等待 ffmpeg 的首个 Progress 统计，那会引入 1~4 秒的
        //    计时偏差与启动期卡顿；ffmpeg 启动即失败由写入失败握手暴露。）
        self.child = Some(child);

        // ffmpeg 的 stderr 保持后台 drain：stderr 为管道且无人读取时会写满
        // 缓冲区（约 64KB，几分钟的统计输出）进而阻塞 ffmpeg 自身
        if let Some(stderr) = self.child.as_mut().unwrap().take_stderr() {
            let _ = std::thread::Builder::new()
                .name("ffmpeg-stderr-drain".into())
                .spawn(move || {
                    use std::io::Read;
                    let mut reader = std::io::BufReader::new(stderr);
                    let mut buf = [0u8; 4096];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                });
        }

        self.state = VideoRecordState::Recording;
        self.segments.push(segment_filename);
        if enable_system_audio {
            self.sys_audio_segments.push(audio_raw_path);
        }
        self.segment_counter += 1;
        Ok(())
    }

    /// 解析 pinray 采集目标：录制区域中心所在的显示器。
    /// 返回 (显示器源 ID, 相对显示器原点的裁剪区域, 区域宽, 区域高)。
    /// 跨屏区域会夹取到该显示器范围（与 legacy macOS 行为一致）。
    #[allow(unused_variables)]
    fn resolve_pinray_target(
        params: &RecordingParams,
    ) -> std::result::Result<(String, Option<pinray::Rect>, i32, i32, MonitorInfo), String> {
        let center_x = (params.min_x + params.max_x) / 2;
        let center_y = (params.min_y + params.max_y) / 2;

        #[cfg(target_os = "windows")]
        {
            let monitors = xcap::Monitor::all().unwrap_or_default();
            let target = monitors
                .iter()
                .find(|monitor| {
                    let (mx, my) = (monitor.x().unwrap_or(0), monitor.y().unwrap_or(0));
                    let (mw, mh) = (
                        monitor.width().unwrap_or(0) as i32,
                        monitor.height().unwrap_or(0) as i32,
                    );
                    center_x >= mx && center_x < mx + mw && center_y >= my && center_y < my + mh
                })
                .or_else(|| monitors.first());

            let monitor =
                target.ok_or_else(|| "No monitor found for recording area".to_string())?;

            // 显示器物理矩形（EnumDisplaySettingsW），与 pinray DXGI 枚举坐标系一致
            let monitor_info = MonitorInfo::new(monitor, None);
            let device_name = MonitorInfo::get_device_name(monitor)?;

            let min_x = params.min_x.max(monitor_info.rect.min_x);
            let min_y = params.min_y.max(monitor_info.rect.min_y);
            let max_x = params.max_x.min(monitor_info.rect.max_x);
            let max_y = params.max_y.min(monitor_info.rect.max_y);

            let mut width = max_x - min_x;
            let mut height = max_y - min_y;
            if width <= 0 || height <= 0 {
                return Err("Recording area is outside the target monitor".to_string());
            }
            if width % 2 == 1 {
                width -= 1;
            }
            if height % 2 == 1 {
                height -= 1;
            }

            return Ok((
                format!("display:{}", device_name),
                Some(pinray::Rect {
                    x: min_x - monitor_info.rect.min_x,
                    y: min_y - monitor_info.rect.min_y,
                    width: width as u32,
                    height: height as u32,
                }),
                width,
                height,
                monitor_info,
            ));
        }

        #[cfg(target_os = "macos")]
        {
            let monitor_list = MonitorList::all(true);
            let mut target_monitor_index = 0;
            for (monitor_index, monitor) in monitor_list.iter().enumerate() {
                use snow_shot_app_shared::ElementRect;

                if monitor.rect.overlaps(&ElementRect {
                    min_x: params.min_x,
                    min_y: params.min_y,
                    max_x: params.max_x,
                    max_y: params.max_y,
                }) {
                    target_monitor_index = monitor_index;
                    break;
                }
            }

            let monitor_info = monitor_list
                .iter()
                .nth(target_monitor_index)
                .ok_or_else(|| "No monitor found for recording area".to_string())?
                .clone();
            // macOS 显示器源 ID 为 CGDirectDisplayID 十进制串（xcap Monitor::id()）
            let display_id = monitor_info
                .monitor
                .id()
                .map_err(|e| format!("Failed to get monitor id: {e:?}"))?;

            let min_x = params.min_x.max(monitor_info.rect.min_x);
            let min_y = params.min_y.max(monitor_info.rect.min_y);
            let max_x = params.max_x.min(monitor_info.rect.max_x);
            let max_y = params.max_y.min(monitor_info.rect.max_y);

            let mut width = max_x - min_x;
            let mut height = max_y - min_y;
            if width <= 0 || height <= 0 {
                return Err("Recording area is outside the target monitor".to_string());
            }
            if width % 2 == 1 {
                width -= 1;
            }
            if height % 2 == 1 {
                height -= 1;
            }

            Ok((
                display_id.to_string(),
                Some(pinray::Rect {
                    x: min_x - monitor_info.rect.min_x,
                    y: min_y - monitor_info.rect.min_y,
                    width: width as u32,
                    height: height as u32,
                }),
                width,
                height,
                monitor_info,
            ))
        }
    }

    /// 启动独立 ffmpeg 进程把麦克风录制为 raw PCM（s16le 48kHz 双声道）。
    /// 成功时文件路径已记录到 mic_audio_segments；失败时调用方降级为无声录制。
    #[allow(unused_variables)]
    fn spawn_pinray_mic_recorder(
        &mut self,
        params: &RecordingParams,
    ) -> std::result::Result<(), String> {
        let mic_filename = format!(
            "{}_segment_{:03}_mic.raw",
            params.output_file, self.segment_counter
        );

        let mut command = self.get_ffmpeg_command();

        #[cfg(target_os = "windows")]
        {
            // dshow 设备枚举要拉起 ffmpeg 子进程（1~3s），使用缓存避免每次
            // 开始录制/恢复录制都枚举；设备热插拔后列表可能过期，但"匹配不到
            // 就用第一个设备"的降级逻辑与实时枚举时一致
            if self.mic_device_names_cache.is_none() {
                self.mic_device_names_cache = Some(self.get_microphone_device_names());
            }
            let device_names = self.mic_device_names_cache.as_ref().unwrap().clone();
            if device_names.is_empty() {
                return Err("No microphone device found".to_string());
            }
            let device_name = if device_names.contains(&params.microphone_device_name) {
                params.microphone_device_name.clone()
            } else {
                device_names[0].clone()
            };
            command
                .arg("-f")
                .arg("dshow")
                .arg("-i")
                .arg(format!("audio={}", device_name));
        }

        #[cfg(target_os = "macos")]
        {
            let device_info_list = self.get_device_info_list();
            let audio_device = device_info_list.iter().find(|d| {
                d.device_type == DeviceType::Audio
                    && Self::format_device_name(d) == params.microphone_device_name
            });
            let device_index = match audio_device {
                Some(device) => device.index,
                None => {
                    return Err(format!(
                        "Microphone device not found: {}",
                        params.microphone_device_name
                    ));
                }
            };
            command
                .arg("-f")
                .arg("avfoundation")
                .arg("-i")
                .arg(format!(":{}", device_index));
        }

        // 麦克风不经过 pinray（其 Microphone 后端未实现，build 即返回 Unsupported），
        // 由独立 ffmpeg 进程采集。下面的 -f s16le -ar 48000 -ac 2 是【输出端】强制归一化：
        // 无论设备原生采样率/声道数如何，ffmpeg 都会自动重采样到该格式，raw 文件格式恒定。
        // mux_pinray_audio 的读取端参数必须与此约定保持一致。
        command
            .arg("-f")
            .arg("s16le")
            .arg("-ar")
            .arg("48000")
            .arg("-ac")
            .arg("2")
            .arg("-y")
            .arg(&mic_filename);

        let child = command
            .spawn()
            .map_err(|e| format!("Failed to spawn mic recorder: {e}"))?;
        self.mic_child = Some(child);
        self.mic_audio_segments.push(mic_filename);
        Ok(())
    }

    /// 停止 pinray 采集与相关子进程（暂停/停止共用）。
    /// 返回本片段的系统声音元信息。
    fn stop_pinray_segment(&mut self) -> Option<SystemAudioMeta> {
        // 1. 停止采集线程（关闭 stdin → ffmpeg 收到 EOF 自然收尾）
        let mut sys_meta = None;
        if let Some(mut feed) = self.pinray_feed.take() {
            sys_meta = feed.stop();
        }
        if sys_meta.is_some() {
            self.sys_audio_meta = sys_meta;
        }

        // 2. 停止麦克风录制进程
        if let Some(mut mic_child) = self.mic_child.take() {
            let _ = mic_child.quit();
            let _ = mic_child.wait();
        }

        // 3. 等待 ffmpeg 完成写 trailer（stdin EOF 后应自然退出；超时兜底 kill）
        if let Some(mut child) = self.child.take() {
            Self::wait_child_or_kill(&mut child, Duration::from_secs(15));
        }

        sys_meta
    }

    fn wait_child_or_kill(child: &mut FfmpegChild, timeout: Duration) {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match child.as_inner_mut().try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {
                    if std::time::Instant::now() > deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return,
            }
        }
    }

    /// 将各片段 raw PCM 文件字节级合并为单个文件（成功后删除片段文件）。
    fn concat_raw_files(
        &self,
        files: &[String],
        output_path: String,
    ) -> std::result::Result<String, String> {
        use std::io::Write as IoWrite;

        if files.is_empty() {
            return Err("no raw files to concat".to_string());
        }

        let mut out = std::fs::File::create(&output_path).map_err(|e| e.to_string())?;
        let mut total_size = 0usize;
        for file in files {
            let data = std::fs::read(file).map_err(|e| e.to_string())?;
            total_size += data.len();
            out.write_all(&data).map_err(|e| e.to_string())?;
        }
        drop(out);

        // 所有片段均为空（如设备打开后立即失败）时视为无有效音频，
        // 避免把空 raw 文件交给 ffmpeg 导致 mux 失败并残留垃圾文件
        if total_size == 0 {
            let _ = std::fs::remove_file(&output_path);
            return Err("all audio segment files are empty".to_string());
        }

        for file in files {
            let _ = std::fs::remove_file(file);
        }
        Ok(output_path)
    }

    /// pinray 模式录制结束后的音频合成：
    /// 视频流 copy，麦克风（含降噪，与 legacy 行为一致）与系统声音（可混音）重编码为 aac。
    fn mux_pinray_audio(&self, final_filename: &str) -> Result<()> {
        let params = self.recording_params.as_ref().unwrap();
        // GIF 片段不含音轨，无需 mux；MP4/MKV/MOV 均兼容 AAC 音轨
        if params.format == VideoFormat::Gif {
            return Ok(());
        }

        let mic_raw_path = if self.mic_audio_segments.is_empty() {
            None
        } else {
            match self.concat_raw_files(
                &self.mic_audio_segments,
                format!("{}_mic.raw", params.output_file),
            ) {
                Ok(path) => Some(path),
                Err(e) => {
                    log::warn!("[mux_pinray_audio] failed to concat mic raw: {e}");
                    None
                }
            }
        };

        let sys_raw_path = match self.sys_audio_meta {
            Some(meta) => self
                .concat_raw_files(
                    &self.sys_audio_segments,
                    format!("{}_sys.raw", params.output_file),
                )
                .ok()
                .map(|path| (path, meta)),
            None => None,
        };

        if mic_raw_path.is_none() && sys_raw_path.is_none() {
            return Ok(());
        }

        let tmp_filename = format!(
            "{}_mux_tmp.{}",
            params.output_file,
            params.format.extension()
        );

        let mut command = self.get_ffmpeg_command();
        command.arg("-i").arg(final_filename);

        // 麦克风 raw 读取参数（s16le/48k/2ch）与 spawn_pinray_mic_recorder 写入端的
        // 强制归一化约定一致（见其注释）；系统声音 raw 读取参数来自 pinray 音频帧的
        // 动态元信息（sys_audio_meta），二者不可能与实际写入格式不符。
        match (&mic_raw_path, &sys_raw_path) {
            (Some(mic_path), None) => {
                command
                    .arg("-f")
                    .arg("s16le")
                    .arg("-ar")
                    .arg("48000")
                    .arg("-ac")
                    .arg("2")
                    .arg("-i")
                    .arg(mic_path);
                command
                    .arg("-filter_complex")
                    .arg("[1:a]anlmdn=s=10:p=0.001:r=0.005[aout]")
                    .arg("-map")
                    .arg("0:v")
                    .arg("-map")
                    .arg("[aout]");
            }
            (None, Some((sys_path, meta))) => {
                command
                    .arg("-f")
                    .arg(meta.ffmpeg_format())
                    .arg("-ar")
                    .arg(meta.sample_rate.to_string())
                    .arg("-ac")
                    .arg(meta.channels.to_string())
                    .arg("-i")
                    .arg(sys_path);
                command.arg("-map").arg("0:v").arg("-map").arg("1:a");
            }
            (Some(mic_path), Some((sys_path, meta))) => {
                command
                    .arg("-f")
                    .arg("s16le")
                    .arg("-ar")
                    .arg("48000")
                    .arg("-ac")
                    .arg("2")
                    .arg("-i")
                    .arg(mic_path);
                command
                    .arg("-f")
                    .arg(meta.ffmpeg_format())
                    .arg("-ar")
                    .arg(meta.sample_rate.to_string())
                    .arg("-ac")
                    .arg(meta.channels.to_string())
                    .arg("-i")
                    .arg(sys_path);
                command
                    .arg("-filter_complex")
                    .arg("[1:a]anlmdn=s=10:p=0.001:r=0.005[mic];[mic][2:a]amix=inputs=2:duration=longest[aout]")
                    .arg("-map")
                    .arg("0:v")
                    .arg("-map")
                    .arg("[aout]");
            }
            (None, None) => return Ok(()),
        }

        command
            .arg("-c:v")
            .arg("copy")
            .arg("-c:a")
            .arg("aac")
            .arg("-b:a")
            .arg("128k")
            .arg("-movflags")
            .arg("+faststart")
            .arg("-y")
            .arg(&tmp_filename);

        println!("FFmpeg mux audio command args: {:?}", command);

        let mut child = command.spawn().map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to spawn mux process: {e}"),
            )
        })?;
        let _ = child.wait();

        if !std::path::Path::new(&tmp_filename).exists() {
            // mux 失败：保留无音频视频，并清理已合并的 raw 文件
            log::warn!("[mux_pinray_audio] mux output not found, keeping video without audio");
            if let Some(path) = &mic_raw_path {
                let _ = std::fs::remove_file(path);
            }
            if let Some((path, _)) = &sys_raw_path {
                let _ = std::fs::remove_file(path);
            }
            return Ok(());
        }

        // 用 mux 结果替换最终文件
        std::fs::remove_file(final_filename).ok();
        std::fs::rename(&tmp_filename, final_filename).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to rename muxed file: {e}"),
            )
        })?;

        // 清理合并后的 raw 文件
        if let Some(path) = &mic_raw_path {
            let _ = std::fs::remove_file(path);
        }
        if let Some((path, _)) = &sys_raw_path {
            let _ = std::fs::remove_file(path);
        }

        Ok(())
    }

    /// 根据编码器类型设置编码器与预设参数（legacy 与 pinray 管线共用）
    fn apply_encoder_preset(command: &mut FfmpegCommand, encoder: &str, encoder_preset: &str) {
        command.arg("-c:v").arg(encoder);

        // 根据编码器类型设置预设值
        // 注意: 检查顺序很重要,必须先检查特定编码器,最后才检查通用编码器
        if encoder.contains("amf") {
            // AMD AMF编码器只支持特定的预设值
            let amf_preset = match encoder_preset {
                "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" => "speed",
                "medium" | "slow" => "balanced",
                "slower" | "veryslow" | "placebo" => "quality",
                // 如果已经是AMF支持的预设值，直接使用
                "speed" | "balanced" | "quality" => encoder_preset,
                _ => "balanced", // 默认使用balanced
            };
            command.arg("-preset").arg(amf_preset);
        } else if encoder.starts_with("libaom") || encoder.starts_with("av1_") {
            // AV1编码器使用global_quality参数 (详见 get_global_quality 函数注释)
            let quality = get_global_quality(encoder_preset);
            command.arg("-global_quality").arg(quality.to_string());
        } else if encoder.starts_with("libvpx") {
            // VP9编码器使用global_quality参数 (详见 get_global_quality 函数注释)
            let quality = get_global_quality(encoder_preset);
            command.arg("-global_quality").arg(quality.to_string());
        } else if encoder.starts_with("mpeg4") {
            // MPEG4编码器使用qscale参数
            let quality = get_mpeg4_quality(encoder_preset);
            command.arg("-qscale").arg(quality.to_string());
        } else if encoder.starts_with("prores") {
            // ProRes编码器使用profile参数
            let quality = get_prores_quality(encoder_preset);
            command.arg("-profile").arg(quality.to_string());
        } else if encoder.starts_with("h264_qsv") {
            // Intel H264_QSV编码器使用global_quality参数
            let quality = get_global_quality(encoder_preset);
            command.arg("-global_quality").arg(quality.to_string());
        } else if encoder.contains("nvenc") {
            // NVIDIA NVENC编码器支持的预设值
            let nvenc_preset = match encoder_preset {
                "ultrafast" => "p1",              // 最快
                "superfast" | "veryfast" => "p2", // 更快
                "faster" | "fast" => "p3",        // 快
                "medium" => "p4",                 // 中等（默认）
                "slow" => "p5",                   // 慢
                "slower" => "p6",                 // 更慢
                "veryslow" | "placebo" => "p7",   // 最慢
                // 如果已经是NVENC支持的预设值，直接使用
                "p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7" | "hq" | "hp" | "ll" | "llhq"
                | "llhp" | "default" | "bd" | "lossless" | "losslesshp" => encoder_preset,
                _ => "p4", // 默认使用p4（中等）
            };
            command.arg("-preset").arg(nvenc_preset);
        } else {
            // 其他编码器（如x264）使用原始预设值
            command.arg("-preset").arg(encoder_preset);
        }
    }

    #[cfg(target_os = "macos")]
    pub fn get_device_info_list(&self) -> Vec<DeviceInfo> {
        let mut device_info_list = Vec::new();

        let mut command = self.get_ffmpeg_command();
        command
            .arg("-list_devices")
            .arg("true")
            .arg("-f")
            .arg("avfoundation")
            .arg("-i")
            .arg("dummy");

        log::info!("FFmpeg get_device_info_list command (macOS): {:?}", command);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => {
                log::error!("[get_device_info_list] Failed to spawn ffmpeg: {}", e);
                return device_info_list;
            }
        };

        let output_iter = match child.iter() {
            Ok(output) => output,
            Err(e) => {
                log::error!("[get_device_info_list] Failed to iter ffmpeg: {}", e);
                return device_info_list;
            }
        };

        // macOS avfoundation 格式的正则表达式
        // 格式: [AVFoundation indev @ 0x...] [info] [0] 设备名称
        let device_regex =
            match Regex::new(r#"\[AVFoundation indev @ [^\]]+\]\s+\[info\]\s+\[(\d+)\]\s+(.+)"#) {
                Ok(regex) => regex,
                Err(e) => {
                    log::error!("[get_device_info_list] Failed to create regex: {}", e);
                    return device_info_list;
                }
            };

        // 检测当前正在解析的设备类型
        let mut current_device_type = DeviceType::Video;

        for line in output_iter {
            match line {
                FfmpegEvent::Log(_, line) => {
                    // 检查是否遇到了视频设备列表的标记
                    if line.contains("AVFoundation video devices") {
                        current_device_type = DeviceType::Video;
                        log::info!(
                            "[get_device_info_list] Found video devices marker, starting to parse devices"
                        );
                        continue;
                    }

                    // 检查是否遇到了音频设备列表的标记
                    if line.contains("AVFoundation audio devices") {
                        current_device_type = DeviceType::Audio;
                        log::info!(
                            "[get_device_info_list] Found audio devices marker, starting to parse devices"
                        );
                        continue;
                    }

                    if let Some(captures) = device_regex.captures(&line) {
                        let device_index = captures.get(1).unwrap().as_str().to_string();
                        let device_name = captures.get(2).unwrap().as_str().to_string();
                        device_info_list.push(DeviceInfo {
                            name: device_name,
                            index: device_index.parse::<usize>().unwrap(),
                            device_type: current_device_type,
                        });
                    }
                }
                _ => {}
            }
        }

        let _ = child.wait();

        log::info!(
            "[get_device_names] Total found devices: {}",
            device_info_list.len()
        );
        device_info_list
    }

    #[cfg(target_os = "macos")]
    fn format_device_name(device_info: &DeviceInfo) -> String {
        format!("[{}] {}", device_info.index, device_info.name)
    }

    pub fn get_microphone_device_names(&mut self) -> Vec<String> {
        let mut device_names = Vec::new();

        #[cfg(target_os = "windows")]
        {
            let mut command = self.get_ffmpeg_command();
            command
                .arg("-list_devices")
                .arg("true")
                .arg("-f")
                .arg("dshow")
                .arg("-i")
                .arg("dummy");

            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(e) => {
                    println!(
                        "[get_microphone_device_names] Failed to spawn ffmpeg: {}",
                        e
                    );
                    return device_names;
                }
            };

            let output_iter = match child.iter() {
                Ok(output) => output,
                Err(e) => {
                    println!("[get_microphone_device_names] Failed to iter ffmpeg: {}", e);
                    return device_names;
                }
            };

            // Windows dshow 格式的正则表达式
            // 格式: [dshow @ address] [info] "设备名称" (audio)
            let device_regex = match Regex::new(r#"\[info\]\s+"([^"]+)"\s+\(audio\)"#) {
                Ok(regex) => regex,
                Err(e) => {
                    println!(
                        "[get_microphone_device_names] Failed to create regex: {}",
                        e
                    );
                    return device_names;
                }
            };

            for line in output_iter {
                match line {
                    FfmpegEvent::Log(_, line) => {
                        // 使用正则表达式解析音频设备
                        if let Some(captures) = device_regex.captures(&line) {
                            if let Some(device_name) = captures.get(1) {
                                let name = device_name.as_str().to_string();
                                device_names.push(name.clone());
                                println!(
                                    "[get_microphone_device_names] Found audio device: {}",
                                    name
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }

            let _ = child.wait();
        }

        #[cfg(target_os = "macos")]
        {
            let device_info_list = self.get_device_info_list();
            for device_info in device_info_list {
                if device_info.device_type == DeviceType::Audio {
                    device_names.push(Self::format_device_name(&device_info));
                }
            }
        }

        println!(
            "[get_microphone_device_names] Total found devices: {}",
            device_names.len()
        );
        // 供录制启动路径复用（设置页查询后缓存即刷新）
        if !device_names.is_empty() {
            self.mic_device_names_cache = Some(device_names.clone());
        }
        device_names
    }

    /// 根据设备名称获取设备索引
    /// 返回 Option<u32>，如果找不到设备则返回 None
    pub fn get_microphone_device_index(&self, device_name: &str) -> Option<u32> {
        // 使用正则表达式从设备名称中提取索引
        // 设备名称格式: [0] 设备名称
        if let Ok(device_index_regex) = Regex::new(r#"\[(\d+)\]\s+(.+)"#) {
            if let Some(captures) = device_index_regex.captures(device_name) {
                if let Some(index_match) = captures.get(1) {
                    if let Ok(device_index) = index_match.as_str().parse::<u32>() {
                        println!(
                            "[get_microphone_device_index] Found device index {} for device: {}",
                            device_index, device_name
                        );
                        return Some(device_index);
                    }
                }
            }
        }

        println!(
            "[get_microphone_device_index] Failed to extract index from device name: {}",
            device_name
        );
        None
    }

    pub fn kill(&mut self) -> Result<()> {
        // 尽量优雅地终止：先关 stdin（EOF）让 ffmpeg 写完 trailer（moov），
        // 有界等待，超时才强杀——否则产物 MP4 缺 moov 无法播放。
        // 该路径由前端"关闭录制窗口/卸载工具栏"触发，属正常用户操作。
        if let Some(mut feed) = self.pinray_feed.take() {
            feed.stop();
        }
        if let Some(mut mic_child) = self.mic_child.take() {
            let _ = mic_child.quit();
            let _ = mic_child.wait();
        }
        if let Some(mut child) = self.child.take() {
            Self::wait_child_or_kill(&mut child, Duration::from_secs(5));
        }

        self.cleanup();
        Ok(())
    }

    fn get_final_filename(&self) -> String {
        let params = self.recording_params.as_ref().unwrap();
        format!("{}.{}", params.output_file, params.format.extension())
    }

    pub fn stop(
        &mut self,
        convert_to_gif: bool,
        gif_format: &str,
        gif_frame_rate: u32,
        gif_max_width: i32,
        gif_max_height: i32,
    ) -> Result<Option<String>> {
        if self.state != VideoRecordState::Recording && self.state != VideoRecordState::Paused {
            return Ok(None);
        }

        println!("[FFmpeg] Stopping and merging segments");

        // 停止当前录制：pinray 路径停采集线程（stdin EOF 让 ffmpeg 收尾），
        // legacy 路径向 ffmpeg stdin 写 "q"（其 stdin 为控制通道，无数据流）
        let capture_backend = self
            .recording_params
            .as_ref()
            .map(|p| p.capture_backend)
            .unwrap_or_default();
        if capture_backend != VideoCaptureBackend::Legacy {
            self.stop_pinray_segment();
        } else if let Some(mut child) = self.child.take() {
            let _ = child.quit();
            let _ = child.wait();
        }

        // 如果只有一个片段，直接重命名
        let mut final_filename = self.get_final_filename();
        if self.segments.len() == 1 {
            if let Err(e) = std::fs::rename(&self.segments[0], &final_filename) {
                println!("Failed to rename single segment: {}", e);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to rename segment: {}", e),
                ));
            }
        } else if self.segments.len() > 1 {
            // 多个片段需要合并
            self.merge_segments(final_filename.clone())?;
        }

        // pinray 模式：合成麦克风/系统声音音轨
        if capture_backend != VideoCaptureBackend::Legacy {
            self.mux_pinray_audio(&final_filename)?;
        }

        // 如果需要转换为GIF格式
        if convert_to_gif && self.recording_params.as_ref().unwrap().format == VideoFormat::Mp4 {
            final_filename = self.convert_to_gif(
                gif_format,
                &final_filename,
                gif_frame_rate,
                gif_max_width,
                gif_max_height,
            )?;
        }

        self.cleanup();
        Ok(Some(final_filename))
    }

    fn merge_segments(&mut self, final_filename: String) -> Result<()> {
        let params = self.recording_params.as_ref().unwrap();

        // 创建临时的文件列表
        let list_filename = format!("{}_segments.txt", params.output_file);
        let mut list_content = String::new();

        for segment in &self.segments {
            list_content.push_str(&format!("file '{}'\n", segment));
        }

        if let Err(e) = std::fs::write(&list_filename, list_content) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to create segment list: {}", e),
            ));
        }

        // 使用ffmpeg合并片段
        let mut command = self.get_ffmpeg_command();
        command
            .arg("-f")
            .arg("concat")
            .arg("-safe")
            .arg("0")
            .arg("-i")
            .arg(&list_filename)
            .arg("-c")
            .arg("copy")
            .arg("-y")
            .arg(&final_filename);

        println!("Merging segments with command: {:?}", command);

        match command.spawn() {
            Ok(mut child) => {
                let _ = child.wait();

                // 删除临时文件列表
                let _ = std::fs::remove_file(&list_filename);

                // 删除所有片段文件
                for segment in &self.segments {
                    if let Err(e) = std::fs::remove_file(segment) {
                        println!("Warning: Failed to delete segment file {}: {}", segment, e);
                    }
                }

                println!("Segments merged successfully");
                Ok(())
            }
            Err(e) => {
                println!("Failed to merge segments: {}", e);
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to merge segments: {}", e),
                ))
            }
        }
    }

    fn convert_to_gif(
        &self,
        format: &str,
        mp4_filename: &str,
        gif_frame_rate: u32,
        gif_max_width: i32,
        gif_max_height: i32,
    ) -> Result<String> {
        let params = self.recording_params.as_ref().unwrap();

        // 生成输出文件名
        let output_filename = if format == "apng" {
            format!("{}.png", params.output_file)
        } else if format == "webp" {
            format!("{}.webp", params.output_file)
        } else {
            format!("{}.gif", params.output_file)
        };

        let format_name = if format == "apng" {
            "APNG"
        } else if format == "webp" {
            "WEBP"
        } else {
            "GIF"
        };
        println!(
            "[FFmpeg] Converting MP4 to {}: {} -> {}",
            format_name, mp4_filename, output_filename
        );

        // 确保输出文件的目录存在
        if let Some(parent_dir) = std::path::Path::new(&output_filename).parent() {
            if let Err(e) = std::fs::create_dir_all(parent_dir) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to create output directory: {}", e),
                ));
            }
        }

        let video_width = self.record_video_size.as_ref().unwrap().0;
        let video_height = self.record_video_size.as_ref().unwrap().1;

        let (target_width, target_height) =
            self.get_actual_video_size(video_width, video_height, gif_max_width, gif_max_height);

        let scale_filter = if target_width != video_width || target_height != video_height {
            format!("scale={}:{}:flags=lanczos", target_width, target_height)
        } else {
            format!("scale=-1:-1:flags=lanczos")
        };

        // 构建FFmpeg命令进行MP4到GIF/APNG的转换
        let mut command = self.get_ffmpeg_command();

        if format == "apng" {
            // APNG格式转换 - 平衡版本
            // APNG 是无损格式，通过压缩级别和预测模式优化
            // 优化策略（平衡模式）：
            // 1. compression_level=6：中等偏高的压缩级别，速度和大小平衡
            // 2. pred=mixed：混合预测模式，对大多数内容压缩效果最好
            command
                .arg("-i")
                .arg(mp4_filename)
                .arg("-vf")
                .arg(format!("fps={},{}", gif_frame_rate, scale_filter))
                .arg("-f")
                .arg("apng")
                .arg("-plays")
                .arg("0") // 无限循环
                .arg("-compression_level")
                .arg("6")
                .arg("-pred")
                .arg("mixed")
                .arg("-y")
                .arg(&output_filename);
        } else if format == "webp" {
            // WEBP格式转换 - 平衡版本，适合日常使用
            // WEBP 支持有损和无损压缩，这里使用有损模式获得更好的压缩率
            // 优化策略（平衡模式）：
            // 1. lossless=0：使用有损压缩模式（文件更小）
            // 2. quality=85：质量设为85（0-100），保证良好视觉效果
            // 3. compression_level=4：中等压缩级别，速度和大小平衡
            // 4. method=4：中等压缩方法，编码速度较快
            command
                .arg("-i")
                .arg(mp4_filename)
                .arg("-vf")
                .arg(format!("fps={},{}", gif_frame_rate, scale_filter))
                .arg("-f")
                .arg("webp")
                .arg("-lossless")
                .arg("0")
                .arg("-quality")
                .arg("85")
                .arg("-compression_level")
                .arg("4")
                .arg("-method")
                .arg("4")
                .arg("-loop")
                .arg("0") // 无限循环
                .arg("-y")
                .arg(&output_filename);
        } else {
            // GIF格式转换 - 平衡版本，适合日常使用
            // 优化策略（平衡模式）：
            // 1. max_colors=192：保留较多颜色，保证视觉质量
            // 2. 使用 diff 统计模式以更好地处理动画
            // 3. 使用 floyd_steinberg 抖动算法提高视觉质量
            // 4. diff_mode=rectangle 优化动画压缩
            command
                .arg("-i")
                .arg(mp4_filename)
                .arg("-vf")
                .arg(format!(
                    "fps={},{},split[s0][s1];[s0]palettegen=max_colors=192:stats_mode=diff[p];[s1][p]paletteuse=dither=floyd_steinberg:diff_mode=rectangle",
                    gif_frame_rate, scale_filter,
                ))
                .arg("-loop")
                .arg("0")
                .arg("-y")
                .arg(&output_filename);
        }

        println!("FFmpeg {} conversion command: {:?}", format_name, command);

        match command.spawn() {
            Ok(mut child) => {
                let _ = child.wait();

                // 检查输出文件是否成功生成
                if std::path::Path::new(&output_filename).exists() {
                    println!(
                        "{} conversion completed successfully: {}",
                        format_name, output_filename
                    );

                    // 删除原始MP4文件
                    if let Err(e) = std::fs::remove_file(mp4_filename) {
                        println!(
                            "Warning: Failed to delete original MP4 file {}: {}",
                            mp4_filename, e
                        );
                    }

                    Ok(output_filename)
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("{} conversion failed - output file not found", format_name),
                    ))
                }
            }
            Err(e) => {
                println!("Failed to convert MP4 to {}: {}", format_name, e);
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to convert MP4 to {}: {}", format_name, e),
                ))
            }
        }
    }

    fn cleanup(&mut self) {
        self.state = VideoRecordState::Idle;
        self.segments.clear();
        self.segment_counter = 0;
        self.recording_params = None;
        self.pinray_feed = None;
        self.mic_child = None;
        self.mic_audio_segments.clear();
        self.sys_audio_segments.clear();
        self.sys_audio_meta = None;
    }

    pub fn pause(&mut self) -> Result<()> {
        if self.state != VideoRecordState::Recording {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "No recording in progress",
            ));
        }

        println!("[FFmpeg] Pausing recording - stopping current segment");

        // 停止当前片段的录制：pinray 路径停采集线程（stdin EOF），
        // legacy 路径向 ffmpeg stdin 写 "q"
        let capture_backend = self
            .recording_params
            .as_ref()
            .map(|p| p.capture_backend)
            .unwrap_or_default();
        if capture_backend != VideoCaptureBackend::Legacy {
            self.stop_pinray_segment();
        } else if let Some(mut child) = self.child.take() {
            let _ = child.quit();
            let _ = child.wait();
        }

        self.state = VideoRecordState::Paused;
        Ok(())
    }

    pub fn resume(&mut self) -> Result<()> {
        if self.state != VideoRecordState::Paused {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Recording is not paused",
            ));
        }

        println!("[FFmpeg] Resuming recording - starting new segment");

        // 开始新片段的录制
        self.start_segment()
    }
}
