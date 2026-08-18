//! 将官方 `xcap::Window` 映射到原生 `HWND`（0.9.8 已移除 `Window::hwnd()`）。
//! 通过 `Window::all()` 与 `EnumWindows` 真实窗口按「可见性+标题+pid+最小化+尺寸」匹配。
//! 注意：`Window::id()` 是内部编号，不等于 HWND，故用属性组合映射而非 id。

use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible,
};
use windows_core::BOOL;
use xcap::Window;

/// 枚举回调的上下文：持有目标窗口的匹配属性与匹配结果。
/// 不持有 `&Window` 引用，避免使用空指针占位导致未定义行为。
struct HwndMatchContext {
    target_title: String,
    target_pid: u32,
    target_minimized: bool,
    target_x: i32,
    target_y: i32,
    target_width: i32,
    target_height: i32,
    found: Option<HWND>,
}

/// 读取窗口标题（UTF-16 -> String）。失败时返回空字符串。
fn get_window_text(hwnd: HWND) -> String {
    let mut buffer = [0u16; 512];
    // GetWindowTextW 在 windows 0.62 接收 &mut [u16]（内部处理容量与结尾 \0）
    let len = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..len as usize])
}

/// `EnumWindows` 回调函数：找到第一个属性匹配的窗口即停止枚举。
unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // Rust 2024 要求 unsafe fn 体内调用 unsafe 操作需显式 unsafe 块。
    let ctx = unsafe { &mut *(lparam.0 as *mut HwndMatchContext) };

    // 跳过不可见窗口（与 xcap 枚举「可捕获窗口」的语义保持一致）
    if unsafe { !IsWindowVisible(hwnd).as_bool() } {
        return BOOL::from(true);
    }

    // 进程 ID 必须一致
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    if pid != ctx.target_pid {
        return BOOL::from(true);
    }

    // 标题必须一致
    let title = get_window_text(hwnd);
    if title != ctx.target_title {
        return BOOL::from(true);
    }

    // 最小化状态必须一致
    if unsafe { IsIconic(hwnd).as_bool() } != ctx.target_minimized {
        return BOOL::from(true);
    }

    // 位置 / 尺寸尽量一致（部分窗口尺寸可能为 0，此时放宽该维度匹配）
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect).is_err() } {
        return BOOL::from(true);
    }
    let x = rect.left;
    let y = rect.top;
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;

    let x_match = ctx.target_width == 0 || x == ctx.target_x;
    let y_match = ctx.target_height == 0 || y == ctx.target_y;
    let w_match = ctx.target_width == 0 || width == ctx.target_width;
    let h_match = ctx.target_height == 0 || height == ctx.target_height;
    if !(x_match && y_match && w_match && h_match) {
        return BOOL::from(true);
    }

    ctx.found = Some(hwnd);
    // 返回 FALSE 停止枚举
    BOOL::from(false)
}

/// 根据一组匹配属性查找原生 `HWND`。
fn find_hwnd_by_attrs(
    title: &str,
    pid: u32,
    minimized: bool,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Option<HWND> {
    let mut ctx = HwndMatchContext {
        target_title: title.to_string(),
        target_pid: pid,
        target_minimized: minimized,
        target_x: x,
        target_y: y,
        target_width: width,
        target_height: height,
        found: None,
    };

    unsafe {
        // EnumWindows 仍可能遇到枚举瞬间销毁的窗口，忽略异常继续。
        let _ = EnumWindows(
            Some(enum_window_callback),
            LPARAM(&mut ctx as *mut _ as isize),
        );
    }

    ctx.found
}

/// 根据 `xcap::Window` 的公开属性匹配其原生 `HWND`。
///
/// 匹配键：可见性 + 进程 ID + 标题 + 最小化状态 + 位置尺寸。
/// 找不到时返回 `None`（例如窗口已销毁或被过滤）。
pub fn find_window_hwnd(window: &Window) -> Option<HWND> {
    let target_title = window.title().unwrap_or_default();
    let target_pid = window.pid().unwrap_or_default();
    let target_minimized = window.is_minimized().unwrap_or(false);
    let target_x = window.x().unwrap_or(0);
    let target_y = window.y().unwrap_or(0);
    let target_width = window.width().unwrap_or(0) as i32;
    let target_height = window.height().unwrap_or(0) as i32;

    find_hwnd_by_attrs(
        &target_title,
        target_pid,
        target_minimized,
        target_x,
        target_y,
        target_width,
        target_height,
    )
}
