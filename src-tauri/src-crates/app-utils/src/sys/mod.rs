//! 平台相关的底层工具模块。
//!
//! 这些工具用于补足官方原版 `xcap` 未暴露的能力（fork 版 xcap 曾提供
//! `Window::hwnd()` / `ImplWindow` 等私有 API，原版已移除）。
//! 所有实现均基于系统原生 API，与 `xcap` 解耦，不修改 `xcap` 源码。

#[cfg(target_os = "windows")]
pub mod windows;
