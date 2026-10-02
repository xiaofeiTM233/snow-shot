//! 录屏 pinray 采集线程。
//!
//! 从 pinray 会话读取视频/音频帧：
//! * 视频帧按恒定声明帧率节拍写入 ffmpeg rawvideo stdin（静态画面/无帧到达时
//!   按墙钟用最近一帧补齐，保证录像时长与真实时间一致）；
//! * 系统声音（WASAPI/SCK loopback）追加写入原始 PCM 文件，录制结束时由
//!   video_record_service 与视频 mux。
//!
//! 注意：ffmpeg 主进程 stdin 承载 rawvideo 数据流，停止时通过关闭 stdin
//! （EOF）让 ffmpeg 自然收尾写 trailer（moov），绝不能向该 stdin 写 "q"
//! 之类控制字符，也不能先于 EOF 强杀进程（否则 MP4 缺 moov 无法播放）。
//!
//! 停止机制：stdin 由 Feed（控制侧）持有，线程通过锁借用写入——因此无论
//! 采集线程是否卡死（如 pinray 后端 stop/事件异常），控制侧都能立即送达
//! EOF；stop() 对线程结束做有界等待，超时则放弃 join（线程后台自行结束），
//! 绝不无限阻塞调用方。

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use pinray::{
    AudioCapture, AudioData, BackendPreference, CaptureEvent, CaptureSession, CursorMode,
    PixelFormat, Rect, SampleFormat, SourceId, VideoCaptureTarget,
};
use serde::{Deserialize, Serialize};

/// 录屏像素格式（用户可选）
#[derive(Serialize, Deserialize, Clone, Debug, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum RecordPixelFormat {
    /// pinray 原生输出，零转换（推荐）
    #[default]
    Bgra,
    /// CPU swizzle 转换为 RGBA
    Rgba,
}

impl RecordPixelFormat {
    fn pinray_pixel_format(&self) -> PixelFormat {
        match self {
            RecordPixelFormat::Bgra => PixelFormat::Bgra8888,
            RecordPixelFormat::Rgba => PixelFormat::Rgba8888,
        }
    }

    /// ffmpeg rawvideo 输入的 pix_fmt 名
    pub fn ffmpeg_pix_fmt(&self) -> &'static str {
        match self {
            RecordPixelFormat::Bgra => "bgra",
            RecordPixelFormat::Rgba => "rgba",
        }
    }
}

/// 录屏视频采集后端（用户可选）
#[derive(Serialize, Deserialize, Clone, Debug, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum VideoCaptureBackend {
    /// pinray 原生采集（默认；Windows WGC / macOS ScreenCaptureKit）
    #[default]
    Pinray,
    /// 传统采集（Windows gdigrab / macOS avfoundation，走 ffmpeg 原生输入）
    Legacy,
}

/// 系统声音元信息（mux 时确定 raw PCM 解码参数）
#[derive(Clone, Copy, Debug)]
pub struct SystemAudioMeta {
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: SampleFormat,
}

impl SystemAudioMeta {
    /// ffmpeg 输入的 PCM 格式名
    pub fn ffmpeg_format(&self) -> &'static str {
        match self.sample_format {
            SampleFormat::I16 => "s16le",
            SampleFormat::I32 => "s32le",
            SampleFormat::F32 => "f32le",
            SampleFormat::F64 => "f64le",
        }
    }

    /// 每采样字节数
    fn sample_size(&self) -> usize {
        match self.sample_format {
            SampleFormat::I16 => 2,
            SampleFormat::I32 | SampleFormat::F32 => 4,
            SampleFormat::F64 => 8,
        }
    }
}

/// 采集线程启动参数（一个录制片段对应一次会话）
pub struct PinrayFeedParams {
    /// pinray 显示器源 ID。Windows: `display:\\.\DISPLAYx`；macOS: CGDirectDisplayID 十进制串
    pub source_id: String,
    /// 相对显示器原点的裁剪区域（物理像素，宽高已偶数化）；None 表示全屏
    pub crop: Option<Rect>,
    pub frame_rate: u32,
    pub pixel_format: RecordPixelFormat,
    /// 是否把鼠标指针合成进画面
    pub capture_cursor: bool,
    pub enable_system_audio: bool,
    /// 本片段系统声音 PCM 输出文件
    pub audio_raw_path: PathBuf,
}

enum ThreadMessage {
    Started,
    AudioMeta(SystemAudioMeta),
    Failed(String),
    /// 线程已完全结束
    Done,
}

/// 一次 pinray 采集会话（一个录制片段）。
///
/// 会话生命周期收敛在采集线程内；stdin 由 Feed（控制侧）持有——stop() 无条件
/// 关闭 stdin 送达 EOF，再对线程做有界等待。
pub struct PinrayFeed {
    stop_flag: Arc<AtomicBool>,
    /// ffmpeg rawvideo stdin 写端；Some=打开，None=已关闭（EOF 已送达）
    stdin_slot: Arc<Mutex<Option<std::process::ChildStdin>>>,
    thread: Option<std::thread::JoinHandle<()>>,
    message_rx: mpsc::Receiver<ThreadMessage>,
}

impl PinrayFeed {
    /// 启动采集线程并等待握手（会话建立成功或失败）。
    ///
    /// `stdin` 为 ffmpeg 的 rawvideo 输入管道写端，所有权移交 Feed（控制侧）。
    pub fn start(
        params: PinrayFeedParams,
        stdin: std::process::ChildStdin,
    ) -> Result<Self, String> {
        let (message_tx, message_rx) = mpsc::channel::<ThreadMessage>();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stdin_slot = Arc::new(Mutex::new(Some(stdin)));

        let thread_stop_flag = stop_flag.clone();
        let thread_stdin_slot = stdin_slot.clone();
        let thread = std::thread::Builder::new()
            .name("pinray-record-feed".into())
            .spawn(move || {
                Self::run(params, thread_stdin_slot, thread_stop_flag, message_tx);
            })
            .map_err(|e| format!("failed to spawn pinray feed thread: {e}"))?;

        // 等待会话建立结果（macOS 首次权限弹窗可能较慢，放宽超时）
        match message_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(ThreadMessage::Started) => Ok(Self {
                stop_flag,
                stdin_slot,
                thread: Some(thread),
                message_rx,
            }),
            Ok(ThreadMessage::Failed(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Ok(_) => {
                let _ = thread.join();
                Err("pinray feed thread unexpected handshake".to_string())
            }
            Err(_) => {
                stop_flag.store(true, Ordering::SeqCst);
                stdin_slot.lock().unwrap().take();
                let _ = thread.join();
                Err("pinray feed thread handshake timeout".to_string())
            }
        }
    }

    /// 停止采集：
    /// 1. 置停止标志；
    /// 2. 无条件关闭 stdin（EOF 送达 ffmpeg，触发其写 trailer 收尾）——
    ///    此步骤不依赖采集线程是否存活；
    /// 3. 有界等待线程结束（超时则放弃 join，线程后台自行结束并释放资源）。
    ///
    /// 返回本片段的系统声音元信息（若启用且收到了音频帧）。
    pub fn stop(&mut self) -> Option<SystemAudioMeta> {
        self.stop_flag.store(true, Ordering::SeqCst);

        // 立即关闭 stdin：EOF 与线程状态解耦
        self.stdin_slot.lock().unwrap().take();

        // 有界等待线程结束，同时收集音频元信息
        let mut meta = None;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut finished = false;
        while !finished {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.message_rx.recv_timeout(remaining.max(Duration::from_millis(1))) {
                Ok(ThreadMessage::Done) => finished = true,
                Ok(ThreadMessage::AudioMeta(audio_meta)) => meta = Some(audio_meta),
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => finished = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if Instant::now() >= deadline {
                        log::warn!(
                            "[PinrayFeed] thread did not finish in time, abandoning it (EOF already delivered)"
                        );
                        break;
                    }
                }
            }
        }

        // 仅在线程确认结束时 join；否则放弃（JoinHandle drop = detach）
        if finished && let Some(thread) = self.thread.take() {
            let _ = thread.join();
        } else {
            self.thread.take();
        }

        meta
    }

    fn run(
        params: PinrayFeedParams,
        stdin_slot: Arc<Mutex<Option<std::process::ChildStdin>>>,
        stop_flag: Arc<AtomicBool>,
        message_tx: mpsc::Sender<ThreadMessage>,
    ) {
        let mut builder = CaptureSession::builder()
            .video_target(VideoCaptureTarget::Display(SourceId::new(params.source_id.clone())))
            .pixel_format(params.pixel_format.pinray_pixel_format())
            .crop_rect(params.crop)
            // pinray 0.2.5 起 Windows 后端（WGC/DXGI）会在源头按该帧率节流，避免为
            // 编码器消费不到的帧做 GPU→CPU 拷贝；节流只是上限：桌面静止时仍不出帧，
            // 由下方墙钟补帧保证录像时长。
            .frame_rate(Some(params.frame_rate))
            // WGC/SCK 默认把鼠标指针合成进帧，按用户设置控制
            .cursor_mode(if params.capture_cursor {
                CursorMode::Embedded
            } else {
                CursorMode::Hidden
            });

        #[cfg(target_os = "windows")]
        {
            builder = builder.backend_preference(BackendPreference::WindowsWgc);
        }
        #[cfg(target_os = "macos")]
        {
            builder = builder.backend_preference(BackendPreference::MacScreenCaptureKit);
        }

        if params.enable_system_audio {
            builder = builder.audio(AudioCapture::SystemMix);
        }

        let mut session = match builder.build() {
            Ok(session) => session,
            Err(e) => {
                let _ = message_tx.send(ThreadMessage::Failed(format!(
                    "pinray build session failed: {e}"
                )));
                return;
            }
        };

        // pinray 要求 bug 报告附带实际选中的后端；Windows 下用于确认走的是 WGC
        // （frame_rate 节流 + 指针开关才生效）而不是 DXGI（不合成指针）。
        let backend = session.backend_info();
        log::info!(
            "[PinrayFeed] backend: {:?} (audio: {}, zero_copy: {}), notes: {}",
            backend.kind,
            backend.supports_audio,
            backend.zero_copy,
            backend.notes
        );

        if let Err(e) = session.start() {
            let _ = message_tx.send(ThreadMessage::Failed(format!(
                "pinray start session failed: {e}"
            )));
            // 兜底关闭 stdin，避免 ffmpeg 永久等待输入
            stdin_slot.lock().unwrap().take();
            return;
        }

        // 会话建立成功，通知主线程
        let _ = message_tx.send(ThreadMessage::Started);

        let interval_nanos = 1_000_000_000i64 / params.frame_rate.max(1) as i64;

        // 帧率节拍锚点：以首个视频帧到达时刻为 0，按墙钟计算应写帧数
        let mut pacing_start: Option<Instant> = None;
        let mut frames_written: u64 = 0;
        let mut last_frame: Option<Vec<u8>> = None;

        // 系统声音 PCM 文件
        let mut audio_file: Option<std::fs::File> = None;
        let mut audio_meta: Option<SystemAudioMeta> = None;
        if params.enable_system_audio {
            match std::fs::File::create(&params.audio_raw_path) {
                Ok(file) => audio_file = Some(file),
                Err(e) => {
                    log::warn!(
                        "[PinrayFeed] failed to create audio raw file {:?}: {}",
                        params.audio_raw_path,
                        e
                    );
                }
            }
        }

        // 向 ffmpeg stdin 写入一帧；stdin 已被控制侧关闭（EOF 已送达）时返回 None
        macro_rules! write_frame {
            ($bytes:expr) => {
                match stdin_slot.lock().unwrap().as_mut() {
                    Some(stdin) => {
                        if stdin.write_all($bytes).is_err() {
                            log::warn!("[PinrayFeed] ffmpeg stdin write failed, exiting feed");
                            let _ = session.stop();
                            stdin_slot.lock().unwrap().take();
                            let _ = message_tx.send(ThreadMessage::Done);
                            return;
                        }
                        true
                    }
                    None => false,
                }
            };
        }

        // 把截至当前时刻到期的帧全部写入（用最近一帧重复填充）。
        // 返回 false 表示 stdin 已关闭，需退出采集循环。
        macro_rules! fill_due {
            () => {{
                let mut ok = true;
                if let Some(start) = pacing_start {
                    let elapsed_nanos = start.elapsed().as_nanos() as i64;
                    let due_count = (elapsed_nanos / interval_nanos).max(0) as u64;
                    if let Some(last) = last_frame.as_ref() {
                        while frames_written < due_count {
                            if !write_frame!(last) {
                                ok = false;
                                break;
                            }
                            frames_written += 1;
                        }
                    }
                }
                ok
            }};
        }

        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }

            match session.next_event(Some(Duration::from_millis(100))) {
                Ok(CaptureEvent::Video(frame)) => {
                    let tight = match frame.to_tight_bytes() {
                        Some(bytes) => bytes,
                        None => {
                            log::warn!("[PinrayFeed] frame data is not host memory, exiting feed");
                            break;
                        }
                    };

                    // 节拍锚点设在首个视频帧
                    if pacing_start.is_none() {
                        pacing_start = Some(Instant::now());
                        last_frame = Some(tight);
                        if !fill_due!() {
                            break;
                        }
                        continue;
                    }

                    last_frame = Some(tight);
                    if !fill_due!() {
                        break;
                    }
                }
                Ok(CaptureEvent::Audio(frame)) => {
                    // 记录首帧元信息（后续格式变化场景 v1 不处理）
                    if audio_meta.is_none() {
                        let meta = SystemAudioMeta {
                            sample_rate: frame.sample_rate,
                            channels: frame.channels,
                            sample_format: frame.sample_format,
                        };
                        audio_meta = Some(meta);
                        let _ = message_tx.send(ThreadMessage::AudioMeta(meta));
                    }

                    if let Some(file) = audio_file.as_mut() {
                        let sample_size = audio_meta.map(|m| m.sample_size()).unwrap_or(4);
                        let bytes = match frame.data {
                            AudioData::Interleaved(data) => data,
                            AudioData::Planar(planes) => {
                                interleave_planar(&planes, frame.channels as usize, sample_size)
                            }
                        };
                        if let Err(e) = file.write_all(&bytes) {
                            log::warn!("[PinrayFeed] failed to write audio raw: {e}");
                        }
                    }
                }
                Ok(CaptureEvent::Gap(gap)) => {
                    match gap.reason {
                        pinray::GapReason::FormatChanged => {
                            // rawvideo 流声明了固定尺寸，格式变化会破坏数据对齐，终止本片段
                            log::warn!(
                                "[PinrayFeed] capture format changed, exiting feed: {:?}",
                                gap.reason
                            );
                            break;
                        }
                        reason => {
                            log::debug!("[PinrayFeed] gap event: {:?}, dropped: {:?}", reason, gap.dropped_frames);
                        }
                    }
                }
                Ok(CaptureEvent::End) => {
                    log::info!("[PinrayFeed] capture stream ended");
                    break;
                }
                Err(pinray::PinrayError::Timeout(_)) => {
                    // 无帧到达（如桌面静止）：按墙钟用最近一帧补齐，维持恒定声明帧率
                    if !fill_due!() {
                        break;
                    }
                }
                Err(e) => {
                    log::warn!("[PinrayFeed] capture error, exiting feed: {e}");
                    break;
                }
            }
        }

        let _ = session.stop();
        // 线程自身退出路径也关闭 stdin（若控制侧尚未关闭），确保 EOF 送达 ffmpeg
        stdin_slot.lock().unwrap().take();
        if let Some(file) = audio_file.as_mut() {
            let _ = file.flush();
        }
        log::info!(
            "[PinrayFeed] feed stopped, frames_written={frames_written}, audio_meta={audio_meta:?}"
        );
        let _ = message_tx.send(ThreadMessage::Done);
    }
}

/// 将 planar 采样数据交错化（macOS SCK 音频可能为 planar 布局）
fn interleave_planar(planes: &[Vec<u8>], channels: usize, bytes_per_sample: usize) -> Vec<u8> {
    if channels == 0 || planes.is_empty() || bytes_per_sample == 0 {
        return Vec::new();
    }

    let samples_per_plane = planes.first().map(|p| p.len()).unwrap_or(0) / bytes_per_sample;

    let mut out = Vec::with_capacity(samples_per_plane * channels * bytes_per_sample);
    for sample_index in 0..samples_per_plane {
        for plane in planes.iter().take(channels) {
            let start = sample_index * bytes_per_sample;
            let end = start + bytes_per_sample;
            if end <= plane.len() {
                out.extend_from_slice(&plane[start..end]);
            }
        }
    }
    out
}
