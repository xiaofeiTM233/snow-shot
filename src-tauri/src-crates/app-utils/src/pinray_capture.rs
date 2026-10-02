//! 基于 pinray 的单帧截图（SDR RGBA8）。
//!
//! pinray 各平台原生后端：Windows 可选 WGC（持续出帧，支持窗口捕获与指针合成）
//! 或 DXGI Desktop Duplication（仅显示器，桌面变化时才出帧，不合成指针），
//! macOS 使用 ScreenCaptureKit。
//! pinray 仅输出 SDR 8bit 帧，HDR 显示器上无 HDR 色彩校正能力。

use std::time::{Duration, Instant};

use image::DynamicImage;
use pinray::{
    CaptureEvent, CaptureSession, CursorMode, PinrayError, PixelFormat, Rect, SourceId,
    VideoCaptureTarget,
};

/// pinray Windows 视频引擎（macOS 固定 ScreenCaptureKit，忽略此参数）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinrayVideoEngine {
    /// Windows Graphics Capture：持续出帧，支持窗口捕获、指针合成。
    /// 冷启动首帧可能因 MPO 未重定向出现视频区域全黑，需丢弃。
    Wgc,
    /// DXGI Desktop Duplication：仅支持显示器捕获（窗口捕获 pinray 会直接报错），
    /// 仅在桌面变化时出帧（静态桌面可能长时间无帧），且不合成鼠标指针。
    /// 硬件视频叠加层（MPO）内容可能缺失，属驱动级行为，等待后续帧无法解决。
    Dxgi,
}

/// 单帧等待超时（WGC 首帧可能需要数百毫秒，循环重试直至截止时间）
const FIRST_FRAME_WAIT: Duration = Duration::from_millis(300);
/// 首帧截止时间
const FIRST_FRAME_DEADLINE: Duration = Duration::from_secs(3);

struct CapturedFrame {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

fn frame_to_image(frame: CapturedFrame) -> Result<DynamicImage, String> {
    // 采集帧的 alpha 通道可能为 0（与 WGC/DXGI 行为一致），统一强制不透明
    let mut rgba = frame.rgba;
    for alpha in rgba.iter_mut().skip(3).step_by(4) {
        *alpha = 255;
    }

    image::RgbaImage::from_raw(frame.width, frame.height, rgba)
        .map(DynamicImage::ImageRgba8)
        .ok_or_else(|| "pinray frame buffer size mismatch".to_string())
}

fn build_session(
    target: VideoCaptureTarget,
    crop: Option<Rect>,
    #[cfg_attr(not(target_os = "windows"), allow(unused_variables))] engine: PinrayVideoEngine,
) -> Result<CaptureSession, String> {
    let mut builder = CaptureSession::builder().video_target(target);

    #[cfg(target_os = "windows")]
    {
        builder = builder.backend_preference(match engine {
            PinrayVideoEngine::Wgc => pinray::BackendPreference::WindowsWgc,
            PinrayVideoEngine::Dxgi => pinray::BackendPreference::WindowsDxgi,
        });
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.backend_preference(pinray::BackendPreference::MacScreenCaptureKit);
    }

    let session = builder
        .pixel_format(PixelFormat::Rgba8888)
        // 截图不应包含鼠标指针（与 WGC 路径的 WithoutCursor 保持一致）。
        // pinray 默认 CursorMode::Embedded，WGC 会 SetIsCursorCaptureEnabled(true)、
        // SCK 会 setShowsCursor(true)，不显式关闭就会把指针合成进帧。
        .cursor_mode(CursorMode::Hidden)
        // 单帧截图无需节流：pinray 0.2.5 起 frame_rate 会被 Windows 后端真正执行
        // （WGC 回调内节流 + Win11 的 SetMinUpdateInterval），显式 None 表示不节流，
        // 首帧按合成器节奏立即交付。macOS 侧 None 仍落到 SCK 默认 60fps。
        .frame_rate(None)
        .crop_rect(crop)
        .build()
        .map_err(|e| format!("pinray build session failed: {e}"))?;

    // pinray 要求 bug 报告附带实际选中的后端（Windows WGC/DXGI、macOS SCK），
    // 用于确认帧率节流与指针开关是否落在预期路径上。
    // 每次单帧截图都会重建会话，内容在进程内是常量，故置 debug 级避免刷屏。
    let backend = session.backend_info();
    log::debug!(
        "[pinray_capture] backend: {:?}, notes: {}",
        backend.kind,
        backend.notes
    );

    Ok(session)
}

/// 从会话中循环等待第一个可用视频帧（Timeout 属正常流，重试直至截止）。
///
/// `drop_first_frame`：是否丢弃冷启动首帧。WGC 会话刚建立时 DWM 尚未把硬件
/// 视频叠加层（MPO，浏览器播放中的视频、部分播放器）重定向进合成 surface，
/// 首帧表现为"桌面正常、视频区域全黑"，与截图路径 windows_capture_image
/// 丢弃首帧的原因一致，取第二帧（约一个合成周期后，视频已合成进画面）。
/// DXGI 桌面复制仅在桌面变化时出帧，静态桌面可能等不到第二帧，因此不丢弃
/// 首帧（其 MPO 缺失属驱动级行为，等待也无法解决）。
fn capture_first_frame(
    mut session: CaptureSession,
    drop_first_frame: bool,
) -> Result<CapturedFrame, String> {
    if let Err(e) = session.start() {
        return Err(format!("pinray start session failed: {e}"));
    }

    let deadline = Instant::now() + FIRST_FRAME_DEADLINE;
    let mut video_frames_seen: u32 = 0;
    loop {
        if Instant::now() > deadline {
            let _ = session.stop();
            return Err("pinray capture first frame timeout".to_string());
        }

        match session.next_event(Some(FIRST_FRAME_WAIT)) {
            Ok(CaptureEvent::Video(frame)) => {
                video_frames_seen += 1;
                if drop_first_frame && video_frames_seen == 1 {
                    continue;
                }

                // to_tight_bytes 去除行填充（stride），rawvideo/图像编码都需要紧凑排布
                let bytes = match frame.to_tight_bytes() {
                    Some(bytes) => bytes,
                    None => {
                        let _ = session.stop();
                        return Err("pinray frame data is not host memory".to_string());
                    }
                };
                let captured = CapturedFrame {
                    width: frame.width,
                    height: frame.height,
                    rgba: bytes,
                };
                let _ = session.stop();
                return Ok(captured);
            }
            Ok(_) => continue,
            Err(PinrayError::Timeout(_)) => continue,
            Err(e) => {
                let _ = session.stop();
                return Err(format!("pinray capture failed: {e}"));
            }
        }
    }
}

/// 截取显示器单帧。
///
/// * `source_id`：pinray 显示器源 ID。Windows 为 `display:\\.\DISPLAYx`
///   （与 `MonitorInfo::get_device_name()` 一致）；macOS 为 CGDirectDisplayID
///   十进制串（即 xcap `Monitor::id()`）。
/// * `crop`：相对显示器原点的裁剪区域（物理像素），None 表示全屏。
/// * `engine`：Windows 视频引擎（WGC/DXGI），macOS 忽略。
pub fn capture_display_frame(
    source_id: String,
    crop: Option<Rect>,
    engine: PinrayVideoEngine,
) -> Result<DynamicImage, String> {
    let session = build_session(
        VideoCaptureTarget::Display(SourceId::new(source_id)),
        crop,
        engine,
    )?;

    // WGC 丢弃冷启动首帧避开 MPO 全黑问题；DXGI 变化出帧，不丢弃（见函数注释）
    let drop_first_frame = engine != PinrayVideoEngine::Dxgi;
    capture_first_frame(session, drop_first_frame).and_then(frame_to_image)
}

/// 截取窗口单帧（仅 Windows；pinray 窗口源 ID 为 `window:{hwnd}`）。
///
/// DXGI Desktop Duplication 不支持窗口捕获，窗口路径固定走 WGC。
/// macOS 下 pinray 窗口捕获输出为显示器尺寸（letterbox 已知问题），不启用。
#[cfg(target_os = "windows")]
pub fn capture_window_frame(hwnd_isize: isize) -> Result<DynamicImage, String> {
    let session = build_session(
        VideoCaptureTarget::Window(SourceId::new(format!("window:{hwnd_isize}"))),
        None,
        PinrayVideoEngine::Wgc,
    )?;

    capture_first_frame(session, true).and_then(frame_to_image)
}
