// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "dhat-heap")]
use app_lib::PROFILER;

#[cfg(feature = "dhat-heap")]
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

#[cfg(feature = "dhat-heap")]
#[tokio::main]
async fn main() {
    #[cfg(feature = "dhat-heap")]
    PROFILER.lock().await.replace(dhat::Profiler::new_heap());

    snow_shot_lib::run();
}

#[cfg(target_os = "windows")]
const DELAY_SECONDS: u64 = 10;

#[cfg(target_os = "macos")]
const DELAY_SECONDS: u64 = 3;

#[cfg(not(feature = "dhat-heap"))]
fn main() {
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::backtrace::Backtrace;

        let backtrace = Backtrace::force_capture();
        log::error!("Panic: {info}\n{backtrace}");
        default_panic(info);
    }));

    // 检测命令行参数是否包含 --auto_start
    // 如果是自动启动可能会失败，尝试延迟一段时间再启动
    let args: Vec<String> = std::env::args().collect();
    if args.contains(&"--auto_start".to_string()) {
        println!(
            "[main] --auto_start parameter detected, delaying {} seconds before starting",
            DELAY_SECONDS
        );
        std::thread::sleep(std::time::Duration::from_secs(DELAY_SECONDS));
    }

    // 在创建 WebView2 渲染子进程之前设置主进程优先级。
    #[cfg(target_os = "windows")]
    {
        let enable = read_boost_process_priority_setting();
        let _ = snow_shot_app_os::utils::set_process_priority(enable);
    }

    snow_shot_lib::run();
}

/// 从持久化的设置文件中读取“提升进程优先级”开关。
/// 仅在 Windows 下调用，读取失败时回退为 false（正常优先级）。
#[cfg(target_os = "windows")]
fn read_boost_process_priority_setting() -> bool {
    const IDENTIFIER: &str = "com.chao.snowshot";
    let config_dir = resolve_config_dir(IDENTIFIER);
    let path = config_dir.join("systemCommon.json");

    let content = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return false,
    };

    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => return false,
    };

    value
        .get("boostProcessPriority")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// 解析配置目录，逻辑对齐前端 `FileCacheService::get_app_config_dir`。
/// 便携版 > 自定义目录 > 全局目录。
#[cfg(target_os = "windows")]
fn resolve_config_dir(identifier: &str) -> std::path::PathBuf {
    // 便携版：exe 所在目录存在 `__portable` 标记文件
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            if exe_dir.join("__portable").exists() {
                return exe_dir.join("configs");
            }
        }
    }

    // 全局 app data 配置目录基址（即 tauri 的 app_config_dir）
    let app_data_config_dir = match std::env::var("APPDATA") {
        Ok(value) => std::path::PathBuf::from(value).join(identifier),
        Err(_) => return std::path::PathBuf::new(),
    };

    // 自定义目录：全局基址下的 `__custom_config_dir` 文件记录着实际路径
    let custom_config_dir_file = app_data_config_dir.join("__custom_config_dir");
    if let Ok(custom_path) = std::fs::read_to_string(&custom_config_dir_file) {
        let custom_path = custom_path.trim();
        if !custom_path.is_empty() && std::path::Path::new(custom_path).exists() {
            return std::path::PathBuf::from(custom_path);
        }
    }

    // 全局目录
    app_data_config_dir.join("configs")
}
