//! 基于 windows-capture 的连续视频采集（Windows 录屏视频源）。
//!
//! 为什么不用 pinray 的 WGC 后端推视频：pinray 未设置 MinUpdateInterval，
//! FrameArrived 按显示器刷新率全速推送（144Hz 屏上即每秒上百次 GPU→CPU
//! 全帧拷贝），录制 30fps 时绝大部分拷贝是浪费，启动期与编码器初始化叠加
//! 造成数秒的卡顿。windows-capture 支持 MinimumUpdateIntervalSettings::
//! Custom，由系统合成器在源头按声明帧率限速推帧（旧系统不支持时降级为
//! Default，由本模块的转换节流兜底）。
//!
//! 输出为 Bgra8（可选 swizzle 为 Rgba8）紧凑排布，上层按声明帧率写入
//! ffmpeg rawvideo stdin。裁剪、冷启动帧丢弃、分辨率变化检测在此完成。

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering},
};
use std::time::{Duration, Instant};

use rayon::iter::{IndexedParallelIterator, ParallelIterator};
use rayon::slice::ParallelSliceMut;
use windows_capture::capture::{
    CaptureControl, Context, GraphicsCaptureApiError, GraphicsCaptureApiHandler,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use crate::monitor_info::MonitorInfo;

/// WGC 回调线程与节拍线程之间的共享状态。
pub struct VideoFrameShared {
    /// 最近一帧（Bgra8/Rgba8 紧凑排布，尺寸 = 期望尺寸），None 表示尚无可用帧
    pub last_frame: Mutex<Option<Vec<u8>>>,
    /// 节拍锚点：首个可用帧的到达时刻（由回调线程设置一次）
    pub pacing_start: Mutex<Option<Instant>>,
    /// 采集错误（如分辨率变化）。非 None 时节拍线程终止本片段
    pub error: Mutex<Option<String>>,
    /// 相邻两次实际转换的最小间隔（纳秒），MinUpdateInterval 不生效的旧系统上
    /// 限制转换频率，把 CPU 开销钉在声明帧率量级
    min_convert_interval_ns: u64,
    last_convert: Mutex<Option<Instant>>,
    baseline: Mutex<Option<(u32, u32)>>,
    frames_seen: AtomicU32,
    stopped: AtomicBool,
}

impl VideoFrameShared {
    pub fn new(frame_rate: u32) -> Self {
        Self {
            last_frame: Mutex::new(None),
            pacing_start: Mutex::new(None),
            error: Mutex::new(None),
            min_convert_interval_ns: 1_000_000_000u64 / frame_rate.max(1) as u64,
            last_convert: Mutex::new(None),
            baseline: Mutex::new(None),
            frames_seen: AtomicU32::new(0),
            stopped: AtomicBool::new(false),
        }
    }

    pub fn mark_stopped(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

pub struct WindowsCaptureVideoFeed {
    shared: Arc<VideoFrameShared>,
    /// 裁剪区域相对帧缓冲原点的偏移（物理像素），None 表示整帧
    crop_origin: Option<(i32, i32)>,
    expected_size: (u32, u32),
    /// true 时输出 RGBA（字节交换），false 输出原生 BGRA
    swap_rb: bool,
}

impl GraphicsCaptureApiHandler for WindowsCaptureVideoFeed {
    type Flags = (Arc<VideoFrameShared>, Option<(i32, i32)>, (u32, u32), bool);
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (shared, crop_origin, expected_size, swap_rb) = ctx.flags;
        Ok(Self {
            shared,
            crop_origin,
            expected_size,
            swap_rb,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.shared.is_stopped() {
            capture_control.stop();
            return Ok(());
        }

        let frames_seen = self.shared.frames_seen.fetch_add(1, Ordering::SeqCst) + 1;
        // 丢弃冷启动首帧（全黑/全零），与截图路径（windows_capture_image）一致
        if frames_seen == 1 {
            return Ok(());
        }

        // 转换节流：MinUpdateInterval 不生效的旧系统上，帧到达率会高于声明
        // 帧率，跳过冗余转换（节拍线程会重复最近一帧，跳过不影响产物）
        let now = Instant::now();
        if let Some(last) = *self.shared.last_convert.lock().unwrap()
            && (now - last).as_nanos() < self.shared.min_convert_interval_ns as u128
        {
            return Ok(());
        }

        let mut buffer = match frame.buffer() {
            Ok(buffer) => buffer,
            Err(e) => {
                let error = format!("failed to get frame buffer: {e:?}");
                *self.shared.error.lock().unwrap() = Some(error.clone());
                capture_control.stop();
                return Ok(());
            }
        };

        // 分辨率基线：首个有效帧确定，其后不一致说明显示器分辨率变化，
        // 会破坏 rawvideo 声明的固定尺寸，终止本片段（恢复录制时按新尺寸
        // 重新声明，语义与 pinray 的 GapReason::FormatChanged 一致）
        let buffer_dims = (buffer.width(), buffer.height());
        {
            let mut baseline = self.shared.baseline.lock().unwrap();
            match *baseline {
                None => *baseline = Some(buffer_dims),
                Some(dims) if dims != buffer_dims => {
                    let error = format!(
                        "capture size changed: {}x{} != {}x{}",
                        buffer_dims.0, buffer_dims.1, dims.0, dims.1
                    );
                    *self.shared.error.lock().unwrap() = Some(error);
                    capture_control.stop();
                    return Ok(());
                }
                Some(_) => {}
            }
        }

        let converted = self.copy_frame_to_tight(&mut buffer);
        *self.shared.last_convert.lock().unwrap() = Some(now);
        *self.shared.last_frame.lock().unwrap() = Some(converted);
        let mut pacing_start = self.shared.pacing_start.lock().unwrap();
        if pacing_start.is_none() {
            *pacing_start = Some(now);
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

impl WindowsCaptureVideoFeed {
    /// 裁剪 + 去 stride：Bgra8（行对齐填充）→ 紧凑排布（可选 Rgba 交换）。
    /// 单次遍历完成裁剪与拷贝，每行交给 rayon 并行处理；纯内存拷贝无逐像素
    /// 数学，开销远低于一帧的 GPU→CPU 拷贝。
    fn copy_frame_to_tight(&self, buffer: &mut windows_capture::frame::FrameBuffer<'_>) -> Vec<u8> {
        let (width, height) = self.expected_size;
        let row_pitch = buffer.row_pitch() as usize;
        let src = buffer.as_raw_buffer();

        let (origin_x, origin_y) = self.crop_origin.unwrap_or((0, 0));
        let (origin_x, origin_y) = (origin_x as usize, origin_y as usize);
        let width = width as usize;
        let height = height as usize;
        let swap_rb = self.swap_rb;

        let mut out = vec![0u8; width * height * 4];
        out.par_chunks_exact_mut(width * 4)
            .enumerate()
            .for_each(|(row, dst_row)| {
                let src_row = &src[(origin_y + row) * row_pitch + origin_x * 4..][..width * 4];
                if swap_rb {
                    for (px, dst) in src_row.chunks_exact(4).zip(dst_row.chunks_exact_mut(4)) {
                        dst[0] = px[2];
                        dst[1] = px[1];
                        dst[2] = px[0];
                        // 采集帧的 alpha 可能为 0（与 WGC 行为一致），统一强制不透明
                        dst[3] = 255;
                    }
                } else {
                    for (px, dst) in src_row.chunks_exact(4).zip(dst_row.chunks_exact_mut(4)) {
                        dst[0] = px[0];
                        dst[1] = px[1];
                        dst[2] = px[2];
                        dst[3] = 255;
                    }
                }
            });
        out
    }
}

/// 全局标志：系统是否支持 DrawBorderSettings::WithoutBorder（与截图路径同语义，
/// 但独立跟踪，避免截图/录屏的失败顺序互相污染）。
static VIDEO_SUPPORTS_WITHOUT_BORDER: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

/// 启动连续视频采集（非阻塞，立即返回控制句柄）。
///
/// * `monitor`：目标显示器信息（含 xcap Monitor，用于解析 HMONITOR）
/// * `crop_origin`：裁剪区域相对帧缓冲原点的偏移（物理像素），None 表示整屏
/// * `expected_size`：期望输出尺寸（物理像素，宽高已偶数化）
/// * `frame_rate`：声明帧率，系统支持的场合以 MinUpdateInterval 在源头限速
/// * `shared`：回调线程与节拍线程的共享状态
/// * `capture_cursor`：是否把鼠标指针合成进画面
/// * `swap_rb`：true 时输出 Rgba8（ffmpeg 输入声明 rgba），false 输出 Bgra8
pub fn start_video_capture(
    monitor: &MonitorInfo,
    crop_origin: Option<(i32, i32)>,
    expected_size: (u32, u32),
    frame_rate: u32,
    shared: Arc<VideoFrameShared>,
    capture_cursor: bool,
    swap_rb: bool,
) -> Result<CaptureControl<WindowsCaptureVideoFeed, String>, String> {
    let capture_monitor = Monitor::from_raw_hmonitor(
        crate::monitor_info::MonitorInfo::get_monitor_handle(&monitor.monitor).0,
    );

    let min_update_interval =
        if windows_capture::graphics_capture_api::GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false)
        {
            MinimumUpdateIntervalSettings::Custom(Duration::from_secs_f64(
                1.0 / f64::from(frame_rate.max(1)),
            ))
        } else {
            MinimumUpdateIntervalSettings::Default
        };

    let build_settings = |border: DrawBorderSettings| {
        Settings::new(
            capture_monitor.clone(),
            if capture_cursor {
                CursorCaptureSettings::WithCursor
            } else {
                CursorCaptureSettings::WithoutCursor
            },
            border,
            SecondaryWindowSettings::Default,
            min_update_interval,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            (shared.clone(), crop_origin, expected_size, swap_rb),
        )
    };

    // 优先 WithoutBorder 去掉 WGC 黄框；系统不支持时回退 Default（与截图路径一致）
    if VIDEO_SUPPORTS_WITHOUT_BORDER.load(Ordering::Relaxed) {
        match WindowsCaptureVideoFeed::start_free_threaded(build_settings(
            DrawBorderSettings::WithoutBorder,
        )) {
            Ok(control) => Ok(control),
            Err(GraphicsCaptureApiError::GraphicsCaptureApiError(
                windows_capture::graphics_capture_api::Error::BorderConfigUnsupported,
            )) => {
                VIDEO_SUPPORTS_WITHOUT_BORDER.store(false, Ordering::Relaxed);
                WindowsCaptureVideoFeed::start_free_threaded(build_settings(
                    DrawBorderSettings::Default,
                ))
                .map_err(|e| format!("failed to start WGC video capture: {e:?}"))
            }
            Err(e) => Err(format!("failed to start WGC video capture: {e:?}")),
        }
    } else {
        WindowsCaptureVideoFeed::start_free_threaded(build_settings(DrawBorderSettings::Default))
            .map_err(|e| format!("failed to start WGC video capture: {e:?}"))
    }
}
