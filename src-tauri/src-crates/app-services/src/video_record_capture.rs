//! 录屏 pinray 采集线程。
//!
//! 从 pinray 会话读取视频/音频帧：
//! * 视频帧按恒定声明帧率节拍交给写入线程，由它写进 ffmpeg rawvideo stdin
//!   （静态画面/无帧到达时按墙钟用最近一帧补齐，保证录像时长与真实时间一致）；
//! * 系统声音（WASAPI/SCK loopback）追加写入原始 PCM 文件，录制结束时由
//!   video_record_service 与视频 mux。
//!
//! 线程划分（关键）：
//! * 采集线程（run）：只从 pinray 取帧，并把「最新一帧 + 待写次数」发布到共享
//!   槽位，永不阻塞；
//! * 写入线程（writer_loop）：独占 ffmpeg stdin，负责阻塞式写入与 EOF。
//!   ffmpeg 管道缓冲只有几十 KB，而一帧原始像素常达 1MB 以上，写入必然要等
//!   编码器消费——若在采集线程里直接写，编码器初始化（QSV/NVENC 需 1~3s）或
//!   编码落后时会连带停住取帧与取音频：画面只能重复上一帧（看起来卡住），
//!   音频队列溢出被丢弃（成片缺音频）。拆开后这些延迟只体现为重复帧数。
//!
//! 时间轴锚点：编码器就绪（写入线程完成首帧写入）之后才开始按墙钟计时——
//! 否则编码器初始化那几秒会被写成一串重复帧，成片开头就是一段静止画面。
//! 就绪前只发布一帧用于预热，音视频都以就绪时刻为 0 点，保证两者对齐。
//!
//! 注意：ffmpeg 主进程 stdin 承载 rawvideo 数据流，停止时通过关闭 stdin
//! （EOF）让 ffmpeg 自然收尾写 trailer（moov），绝不能向该 stdin 写 "q"
//! 之类控制字符，也不能先于 EOF 强杀进程（否则 MP4 缺 moov 无法播放）。
//!
//! 停止机制：stop() 置停止标志并请求关闭 stdin，写入线程随即 drop stdin 送达
//! EOF（不依赖采集线程是否卡死）；stop() 对线程结束做有界等待，超时则放弃
//! join（线程后台自行结束），绝不无限阻塞调用方。

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant};

use pinray::{
    AudioCapture, AudioData, BackendPreference, CaptureEvent, CaptureSession, CursorMode,
    PixelFormat, Rect, SampleFormat, SourceId, VideoCaptureTarget,
};
use serde::{Deserialize, Serialize};

/// ffmpeg rawvideo 输入声明的 pix_fmt，与 `PixelFormat::Rgba8888` 严格对应。
///
/// 采集像素格式固定 RGBA，不再提供 BGRA 选项：截图 SharedBuffer、OCR、剪贴板、
/// 多屏合成、颜色矩阵、图像编码全链路都按 RGBA 字节序实现，BGRA 会让这些消费点
/// 静默出错（红蓝互换 / alpha 取错字节）；统一 RGBA 后全进程只有一种字节序约定。
pub const FFMPEG_PIX_FMT: &str = "rgba";

/// 录屏视频采集后端（用户可选）
#[derive(Serialize, Deserialize, Clone, Debug, Copy, PartialEq, Eq, Default)]
pub enum VideoCaptureBackend {
    /// pinray WGC 引擎（默认；Windows WGC / macOS ScreenCaptureKit）。
    /// alias "pinray" 兼容旧前端调用与旧配置
    #[serde(rename = "pinray-wgc", alias = "pinray")]
    #[default]
    PinrayWgc,
    /// pinray DXGI 引擎（Windows 独有；仅显示器采集，桌面变化时出帧，
    /// 不合成鼠标指针——capture_cursor 在该引擎下无效）
    #[serde(rename = "pinray-dxgi")]
    PinrayDxgi,
    /// 传统采集（Windows gdigrab / macOS avfoundation，走 ffmpeg 原生输入）
    #[serde(rename = "legacy")]
    Legacy,
}

/// pinray Windows 视频引擎（macOS 固定 ScreenCaptureKit，忽略）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PinrayEngine {
    /// Windows Graphics Capture：持续出帧，支持指针合成
    Wgc,
    /// DXGI Desktop Duplication：仅显示器，桌面变化时出帧，不合成指针
    Dxgi,
}

impl VideoCaptureBackend {
    /// pinray 后端对应的 Windows 视频引擎（Legacy 不会走到 pinray 路径）
    pub fn pinray_engine(&self) -> PinrayEngine {
        match self {
            VideoCaptureBackend::PinrayDxgi => PinrayEngine::Dxgi,
            _ => PinrayEngine::Wgc,
        }
    }
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
    /// Windows 视频引擎（WGC/DXGI），macOS 忽略
    pub engine: PinrayEngine,
    /// 是否把鼠标指针合成进画面（DXGI 引擎不支持指针合成，该设置无效）
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

/// 待写入 ffmpeg 的帧槽：只保留「最新一帧 + 待写次数」。
///
/// 编码器跟不上时，后到的帧直接覆盖旧帧并累加次数（旧帧内容被跳过），
/// 因此内存恒定为一帧，而总帧数（时间轴长度）保持不变。
struct FrameSlot {
    /// 最近一帧（紧凑排布的原始像素）
    bytes: Option<Arc<Vec<u8>>>,
    /// 待写入的重复次数（每次到期帧 +1，写入线程写完扣减）
    pending: u64,
}

/// 采集线程与写入线程共享的运行时状态
struct FeedShared {
    /// 帧槽（配 cvar 通知写入线程）
    slot: Mutex<FrameSlot>,
    cvar: Condvar,
    /// 请求关闭 stdin（停止录制/采集结束）
    close: AtomicBool,
    /// 写入线程已完成首帧写入（编码器就绪，时间轴锚点）
    first_write_done: AtomicBool,
    /// 写入失败（管道断开等）
    write_failed: AtomicBool,
    /// 实际写出的帧数（诊断用：与发布的帧数对比可看出编码器是否落后）
    written: AtomicU64,
}

impl FeedShared {
    fn new() -> Self {
        Self {
            slot: Mutex::new(FrameSlot {
                bytes: None,
                pending: 0,
            }),
            cvar: Condvar::new(),
            close: AtomicBool::new(false),
            first_write_done: AtomicBool::new(false),
            write_failed: AtomicBool::new(false),
            written: AtomicU64::new(0),
        }
    }

    /// 发布一帧（覆盖旧帧 + 累加次数），写入线程据此写 pending 次
    fn publish(&self, bytes: Arc<Vec<u8>>) {
        let mut slot = self.slot.lock().unwrap();
        slot.bytes = Some(bytes);
        slot.pending += 1;
        drop(slot);
        self.cvar.notify_one();
    }

    /// 请求关闭 stdin：写入线程停止写入并 drop stdin（ffmpeg 收到 EOF 收尾）
    fn request_close(&self) {
        self.close.store(true, Ordering::SeqCst);
        self.cvar.notify_all();
    }
}

/// 一次 pinray 采集会话（一个录制片段）。
///
/// 生命周期收敛在采集线程内；stdin 由写入线程独占——stop() 置标志并请求关闭
/// 后立即送达 EOF，再对线程做有界等待。
pub struct PinrayFeed {
    stop_flag: Arc<AtomicBool>,
    shared: Arc<FeedShared>,
    thread: Option<std::thread::JoinHandle<()>>,
    message_rx: mpsc::Receiver<ThreadMessage>,
}

impl PinrayFeed {
    /// 启动写入线程与采集线程，并等待握手。
    ///
    /// 握手在「编码器就绪（首帧已真正写进 ffmpeg）」时才返回：ffmpeg 初始化
    /// 编码器（QSV/NVENC 常需 1~3s）期间不产生内容，前端计时也从此刻起算。
    ///
    /// `stdin` 为 ffmpeg 的 rawvideo 输入管道写端，所有权移交写入线程。
    pub fn start(
        params: PinrayFeedParams,
        stdin: std::process::ChildStdin,
    ) -> Result<Self, String> {
        let (message_tx, message_rx) = mpsc::channel::<ThreadMessage>();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(FeedShared::new());

        // 写入线程独占 stdin：阻塞式写入与 EOF（drop stdin）都在这里
        let writer_shared = shared.clone();
        std::thread::Builder::new()
            .name("pinray-record-writer".into())
            .spawn(move || Self::writer_loop(writer_shared, stdin))
            .map_err(|e| format!("failed to spawn pinray writer thread: {e}"))?;

        let thread_stop_flag = stop_flag.clone();
        let thread_shared = shared.clone();
        let thread = match std::thread::Builder::new()
            .name("pinray-record-feed".into())
            .spawn(move || {
                Self::run(params, thread_shared, thread_stop_flag, message_tx);
            }) {
            Ok(thread) => thread,
            Err(e) => {
                // 采集线程没起来：让写入线程收掉 stdin，避免 ffmpeg 永久等输入
                shared.request_close();
                return Err(format!("failed to spawn pinray feed thread: {e}"));
            }
        };

        // 等待编码器就绪结果（macOS 首次权限弹窗、编码器初始化都可能较慢）
        match message_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(ThreadMessage::Started) => Ok(Self {
                stop_flag,
                shared,
                thread: Some(thread),
                message_rx,
            }),
            Ok(ThreadMessage::Failed(e)) => {
                stop_flag.store(true, Ordering::SeqCst);
                shared.request_close();
                let _ = thread.join();
                Err(e)
            }
            Ok(_) => {
                stop_flag.store(true, Ordering::SeqCst);
                shared.request_close();
                let _ = thread.join();
                Err("pinray feed thread unexpected handshake".to_string())
            }
            Err(_) => {
                stop_flag.store(true, Ordering::SeqCst);
                shared.request_close();
                let _ = thread.join();
                Err("pinray feed thread handshake timeout".to_string())
            }
        }
    }

    /// 停止采集：
    /// 1. 置停止标志；
    /// 2. 请求关闭 stdin（EOF 送达 ffmpeg，触发其写 trailer 收尾）——
    ///    由写入线程执行，此步骤不依赖采集线程是否存活；
    /// 3. 有界等待线程结束（超时则放弃 join，线程后台自行结束并释放资源）。
    ///
    /// 返回本片段的系统声音元信息（若启用且收到了音频帧）。
    pub fn stop(&mut self) -> Option<SystemAudioMeta> {
        self.stop_flag.store(true, Ordering::SeqCst);

        // 立即请求关闭 stdin：EOF 与采集线程状态解耦
        self.shared.request_close();

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
        shared: Arc<FeedShared>,
        stop_flag: Arc<AtomicBool>,
        message_tx: mpsc::Sender<ThreadMessage>,
    ) {
        let mut builder = CaptureSession::builder()
            .video_target(VideoCaptureTarget::Display(SourceId::new(params.source_id.clone())))
            .pixel_format(PixelFormat::Rgba8888)
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
            builder = builder.backend_preference(match params.engine {
                PinrayEngine::Wgc => BackendPreference::WindowsWgc,
                PinrayEngine::Dxgi => BackendPreference::WindowsDxgi,
            });
        }
        #[cfg(target_os = "macos")]
        {
            builder = builder.backend_preference(BackendPreference::MacScreenCaptureKit);
        }

        // DXGI 桌面复制不合成指针，capture_cursor 在该引擎下无效（前端已禁用开关，
        // 此处仅作防御性记录，便于从日志排查"开了指针却没录上"的问题）
        #[cfg(target_os = "windows")]
        if params.engine == PinrayEngine::Dxgi && params.capture_cursor {
            log::warn!(
                "[PinrayFeed] capture_cursor is ignored with the DXGI engine (cursor not embedded)"
            );
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

        // pinray 要求 bug 报告附带实际选中的后端；Windows 下用于确认走的是
        // WGC（指针合成生效）还是 DXGI（不合成指针，仅桌面变化时出帧）。
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
            shared.request_close();
            return;
        }

        let interval_nanos = 1_000_000_000i64 / params.frame_rate.max(1) as i64;

        // 帧率节拍锚点：编码器就绪（首帧真正写进 ffmpeg）后按墙钟计算应发布帧数。
        // 就绪之前的帧只用于预热，不计入时间轴，也不写音频——否则编码器初始化
        // 的 1~3s 会变成成片开头的一串重复帧，且音视频起点不一致。
        let mut pacing_start: Option<Instant> = None;
        let mut ready = false;
        let mut frames_published: u64 = 0;
        let mut last_frame: Option<Arc<Vec<u8>>> = None;
        // 诊断：真实收到的视频帧数与上一帧时刻。成片出现长时间静止画面时，
        // 看这里就能区分「桌面本来就没变（WGC 不产帧）」与「采集停帧」：
        // 前者是 WGC 的正常行为（没有 damage 就没有帧），后者说明取帧通路卡住了。
        let mut video_frames_received: u64 = 0;
        let mut last_video_frame_at: Option<Instant> = None;
        let mut last_gap_log_at: Option<Instant> = None;
        // 诊断：画面"有帧但像素没变"的统计（采样哈希），用于识别桌面合成停顿
        let mut last_sample_hash: Option<u64> = None;
        let mut static_run_start: Option<Instant> = None;
        let mut static_runs: u64 = 0;
        let mut longest_static = Duration::ZERO;

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

        // 把截至当前时刻到期的帧全部发布给写入线程（用最近一帧重复填充）。
        // 发布只更新共享槽位、永不阻塞，因此编码器再慢也拖不住取帧与取音频。
        macro_rules! fill_due {
            () => {{
                if let Some(start) = pacing_start {
                    let elapsed_nanos = start.elapsed().as_nanos() as i64;
                    let due_count = (elapsed_nanos / interval_nanos).max(0) as u64;
                    if let Some(last) = last_frame.as_ref() {
                        while frames_published < due_count {
                            shared.publish(last.clone());
                            frames_published += 1;
                        }
                    }
                }
            }};
        }

        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            if shared.write_failed.load(Ordering::SeqCst) {
                // 管道断开（编码器进程提前退出等）：就绪前让握手失败，就绪后收尾
                if ready {
                    log::warn!("[PinrayFeed] ffmpeg stdin write failed, exiting feed");
                } else {
                    let _ = message_tx.send(ThreadMessage::Failed(
                        "ffmpeg stdin write failed".to_string(),
                    ));
                }
                break;
            }

            match session.next_event(Some(Duration::from_millis(100))) {
                Ok(CaptureEvent::Video(frame)) => {
                    let tight = match frame.to_tight_bytes() {
                        Some(bytes) => Arc::new(bytes),
                        None => {
                            log::warn!("[PinrayFeed] frame data is not host memory, exiting feed");
                            break;
                        }
                    };

                    // 诊断：采集侧长时间没有新帧（>1s）时记录下来
                    let now = Instant::now();
                    if let Some(previous) = last_video_frame_at {
                        let gap = now.saturating_duration_since(previous);
                        if gap >= Duration::from_secs(1) {
                            log::info!(
                                "[PinrayFeed] no new video frame for {:.2}s (received {} frames)",
                                gap.as_secs_f32(),
                                video_frames_received
                            );
                        }
                    }
                    last_video_frame_at = Some(now);
                    video_frames_received += 1;

                    // 诊断：像素采样哈希变化 = 画面更新；长时间不变说明桌面合成
                    // 停顿（如 GPU 编码器抢占 GPU），此时录像里就是一段静止画面
                    let sample = sample_hash(&tight);
                    if last_sample_hash != Some(sample) {
                        if let Some(started) = static_run_start.take() {
                            let duration = started.elapsed();
                            if duration >= Duration::from_secs(1) {
                                static_runs += 1;
                                longest_static = longest_static.max(duration);
                                log::warn!(
                                    "[PinrayFeed] captured picture unchanged for {:.2}s",
                                    duration.as_secs_f32()
                                );
                            }
                        }
                        static_run_start = Some(Instant::now());
                        last_sample_hash = Some(sample);
                    }

                    if last_frame.is_none() {
                        // 首帧：只发布一次用于编码器预热（该写入会阻塞到编码器真正
                        // 读走数据），就绪前的这段内容不计入时间轴
                        last_frame = Some(tight.clone());
                        shared.publish(tight);
                    } else {
                        last_frame = Some(tight);
                        if ready {
                            fill_due!();
                        }
                    }
                }
                Ok(CaptureEvent::Audio(frame)) => {
                    // 编码器就绪前丢弃音频：音频与视频必须以同一时刻为 0 点
                    if ready {
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
                            // 通道溢出/后端重启等；节流到每秒一条，避免刷屏
                            let should_log = last_gap_log_at
                                .map(|at: Instant| at.elapsed() >= Duration::from_secs(1))
                                .unwrap_or(true);
                            if should_log {
                                last_gap_log_at = Some(Instant::now());
                                log::info!(
                                    "[PinrayFeed] capture gap: {:?}, dropped: {:?}",
                                    reason,
                                    gap.dropped_frames
                                );
                            }
                        }
                    }
                }
                Ok(CaptureEvent::End) => {
                    log::info!("[PinrayFeed] capture stream ended");
                    break;
                }
                Err(pinray::PinrayError::Timeout(_)) => {
                    // 无帧到达（如桌面静止）：按墙钟用最近一帧补齐，维持恒定声明帧率
                    if ready {
                        fill_due!();
                    }
                }
                Err(e) => {
                    log::warn!("[PinrayFeed] capture error, exiting feed: {e}");
                    break;
                }
            }

            // 编码器就绪（写入线程完成首帧写入）：时间轴 0 点从此刻起算，并通知
            // 主线程——前端计时与成片内容起点因此一致
            if !ready && shared.first_write_done.load(Ordering::SeqCst) {
                ready = true;
                pacing_start = Some(Instant::now());
                let _ = message_tx.send(ThreadMessage::Started);
                fill_due!();
            }
        }

        let _ = session.stop();
        // 采集线程收尾：请求关闭 stdin，写入线程 drop 后 ffmpeg 收到 EOF
        shared.request_close();
        if let Some(file) = audio_file.as_mut() {
            let _ = file.flush();
        }
        if !ready {
            // 从未就绪（编码器一直没消费首帧就结束）：让握手立即失败而不是等超时
            let _ = message_tx.send(ThreadMessage::Failed(
                "pinray capture ended before ffmpeg started consuming frames".to_string(),
            ));
        }
        if let Some(started) = static_run_start.take() {
            let duration = started.elapsed();
            if duration >= Duration::from_secs(1) {
                static_runs += 1;
                longest_static = longest_static.max(duration);
            }
        }
        log::info!(
            "[PinrayFeed] feed stopped, video_frames_received={video_frames_received}, frames_published={frames_published}, frames_written={}, static_runs={static_runs}, longest_static={:.2}s, audio_meta={audio_meta:?}",
            shared.written.load(Ordering::Relaxed),
            longest_static.as_secs_f32()
        );
        let _ = message_tx.send(ThreadMessage::Done);
    }

    /// 独立的 ffmpeg 写入线程：阻塞只发生在这里，不会传染给采集线程。
    ///
    /// 首帧写入会阻塞到编码器真正开始读取（QSV/NVENC 初始化常需 1~3s），
    /// 完成即视为编码器就绪（first_write_done），采集线程据此开始计时与握手。
    fn writer_loop(shared: Arc<FeedShared>, mut stdin: std::process::ChildStdin) {
        let mut first = true;
        loop {
            let (bytes, pending) = {
                let mut slot = shared.slot.lock().unwrap();
                while slot.pending == 0
                    && !shared.close.load(Ordering::SeqCst)
                    && !shared.write_failed.load(Ordering::SeqCst)
                {
                    let (next, _) = shared
                        .cvar
                        .wait_timeout(slot, Duration::from_millis(100))
                        .unwrap();
                    slot = next;
                }
                (slot.bytes.clone(), slot.pending)
            };

            if shared.close.load(Ordering::SeqCst) || shared.write_failed.load(Ordering::SeqCst) {
                break;
            }
            let Some(bytes) = bytes else { continue };
            if pending == 0 {
                continue;
            }

            // 阻塞式写入：一次 pending 可能包含编码器落后期间合并掉的重复帧
            let mut written_now: u64 = 0;
            for _ in 0..pending {
                if shared.close.load(Ordering::SeqCst) {
                    // 停止录制：丢弃剩余重复帧，尽快送 EOF
                    break;
                }
                if let Err(e) = stdin.write_all(&bytes) {
                    log::warn!("[PinrayFeed] ffmpeg stdin write failed: {e}");
                    shared.write_failed.store(true, Ordering::SeqCst);
                    break;
                }
                written_now += 1;
                if first {
                    first = false;
                    shared.first_write_done.store(true, Ordering::SeqCst);
                }
            }

            shared.written.fetch_add(written_now, Ordering::Relaxed);
            let mut slot = shared.slot.lock().unwrap();
            slot.pending = slot.pending.saturating_sub(written_now);
        }

        // 退出即关闭管道（drop stdin）：ffmpeg 收到 EOF 后自然收尾写 trailer
    }
}

/// 采样哈希：按固定步长抽样像素字节（FNV-1a），用于诊断"画面是否变化"。
///
/// 只用于采集侧诊断：完整比较/哈希几 MB 的帧会明显增加开销，抽样足以区分
/// "画面在动"与"整幅画面没变"（GPU 编码器抢占时是后者）。
fn sample_hash(bytes: &[u8]) -> u64 {
    // 质数步长，避免与行宽对齐后产生周期性采样
    const STEP: usize = 4093;

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut index = 0;
    while index < bytes.len() {
        hash ^= u64::from(bytes[index]);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        index += STEP;
    }
    hash ^ (bytes.len() as u64)
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
