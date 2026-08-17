//! Windows 平台相关的底层工具（本地化定制能力，与 xcap 解耦）。

#[cfg(target_os = "windows")]
pub mod hwnd;
