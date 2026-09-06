use std::env;
use std::ffi::c_void;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::Foundation::{HWND, VARIANT_BOOL};
use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::TaskScheduler::{
    self, IAction, IActionCollection, IExecAction, ILogonTrigger, IPrincipal, IRegisteredTask,
    IRegistrationInfo, ITaskDefinition, ITaskFolder, ITaskService, ITaskSettings, ITrigger,
    ITriggerCollection, TASK_ACTION_EXEC, TASK_LOGON_GROUP, TASK_TRIGGER_LOGON,
};
use windows::Win32::System::Threading::{
    ABOVE_NORMAL_PRIORITY_CLASS, GetCurrentProcess, NORMAL_PRIORITY_CLASS, OpenProcessToken,
    SetPriorityClass,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
    SetWindowPos, WS_EX_TOPMOST,
};
use windows::core::Interface;
use windows::core::PCWSTR;

pub fn switch_always_on_top(hwnd: *mut c_void) -> bool {
    let hwnd = HWND(hwnd);

    // 获取窗口的扩展样式
    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };

    // 检查窗口是否已经置顶
    let is_topmost = (ex_style & WS_EX_TOPMOST.0 as isize) != 0;

    // 根据当前状态切换置顶
    let result = unsafe {
        SetWindowPos(
            hwnd,
            if is_topmost {
                Some(HWND_NOTOPMOST)
            } else {
                Some(HWND_TOPMOST)
            },
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE,
        )
    };

    result.is_ok()
}

pub fn set_draw_window_style(#[allow(unused_variables)] window: tauri::Window) {
    // 暂时不处理，保留下函数占位

    // let window_hwnd = window.hwnd();

    // if let Ok(hwnd) = window_hwnd {
    //     // 设置窗口样式为0x96000000
    //     let new_style = -1778384896;
    //     unsafe { SetWindowLongW(hwnd, GWL_STYLE, new_style) };
    // }
}

pub fn get_focused_window() -> HWND {
    unsafe { GetForegroundWindow() }
}

const TASK_NAME: &str = "SnowShot Admin Auto Start";

struct ComGuard;
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

/**
 * 在 Windows 下创建使用管理员权限自动启动任务
 *
 */
pub fn create_admin_auto_start_task() -> Result<(), String> {
    // 获取当前可执行文件的路径
    let current_exe = match env::current_exe() {
        Ok(current_exe) => current_exe,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] env::current_exe failed: {:?}",
                e
            ));
        }
    };
    let exe_path = current_exe.to_string_lossy();

    let _com_guard = ComGuard {};

    // 初始化 COM
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] CoInitializeEx failed: {:?}",
                hr
            ));
        }
    }

    // 创建 Task Service 实例
    let p_service: ITaskService = match unsafe {
        CoCreateInstance(&TaskScheduler::TaskScheduler, None, CLSCTX_INPROC_SERVER)
    } {
        Ok(p_service) => p_service,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] CoCreateInstance failed: {:?}",
                e
            ));
        }
    };

    // 连接到 Task Service
    unsafe {
        let hr = p_service.Connect(
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
        );
        if hr.is_err() {
            return Err("[create_admin_auto_start_task] Connect failed".into());
        }
    }

    // 获取根任务文件夹
    let p_root_folder: ITaskFolder =
        match unsafe { p_service.GetFolder(&windows::core::BSTR::from("\\")) } {
            Ok(p_root_folder) => p_root_folder,
            Err(e) => {
                return Err(format!(
                    "[create_admin_auto_start_task] GetFolder failed: {:?}",
                    e
                ));
            }
        };

    // 删除已存在的同名任务
    let _ = unsafe { p_root_folder.DeleteTask(&windows::core::BSTR::from(TASK_NAME), 0) };

    // 创建任务定义
    let p_task: ITaskDefinition = match unsafe { p_service.NewTask(0) } {
        Ok(p_task) => p_task,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] NewTask failed: {:?}",
                e
            ));
        }
    };

    let p_principal: IPrincipal = match unsafe { p_task.Principal() } {
        Ok(p_principal) => p_principal,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Principal failed: {:?}",
                e
            ));
        }
    };

    // 使用最高权限运行
    unsafe {
        let hr = p_principal.SetRunLevel(TaskScheduler::TASK_RUNLEVEL_HIGHEST);
        if hr.is_err() {
            return Err("[create_admin_auto_start_task] SetRunLevel failed".into());
        }
    }

    // 设置任务注册信息
    let p_reg_info: IRegistrationInfo = match unsafe { p_task.RegistrationInfo() } {
        Ok(p_reg_info) => p_reg_info,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] RegistrationInfo failed: {:?}",
                e
            ));
        }
    };
    unsafe {
        let hr = p_reg_info.SetAuthor(&windows::core::BSTR::from("SnowShot"));
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] SetAuthor failed: {:?}",
                hr
            ));
        }
    }
    unsafe {
        let hr =
            p_reg_info.SetDescription(&windows::core::BSTR::from("Auto start with administrator"));
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] SetDescription failed: {:?}",
                hr
            ));
        }
    }

    // 设置任务设置
    let p_settings: ITaskSettings = match unsafe { p_task.Settings() } {
        Ok(p_settings) => p_settings,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Settings failed: {:?}",
                e
            ));
        }
    };
    unsafe {
        let hr = p_settings.SetStartWhenAvailable(VARIANT_BOOL::from(true));
        if hr.is_err() {
            return Err("[create_admin_auto_start_task] SetStartWhenAvailable failed".into());
        }
    }

    // 设置任务可以在用户未登录时运行（支持管理员权限）
    // 注意：某些 Windows 版本可能不支持此设置，管理员权限主要通过 SID 指定

    // 获取触发器集合并创建登录触发器
    let p_trigger_collection: ITriggerCollection = match unsafe { p_task.Triggers() } {
        Ok(p_trigger_collection) => p_trigger_collection,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Triggers failed: {:?}",
                e
            ));
        }
    };
    let p_trigger: ITrigger = match unsafe { p_trigger_collection.Create(TASK_TRIGGER_LOGON) } {
        Ok(p_trigger) => p_trigger,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Create failed: {:?}",
                e
            ));
        }
    };

    // 将 ITrigger 转换为 ILogonTrigger
    let p_logon_trigger: ILogonTrigger = match p_trigger.cast() {
        Ok(p_logon_trigger) => p_logon_trigger,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] cast failed: {:?}",
                e
            ));
        }
    };
    unsafe {
        let hr = p_logon_trigger.SetId(&windows::core::BSTR::from("LogonTrigger"));
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] SetId failed: {:?}",
                hr
            ));
        }
    }

    // 获取动作集合并创建执行动作
    let p_action_collection: IActionCollection = match unsafe { p_task.Actions() } {
        Ok(p_action_collection) => p_action_collection,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Actions failed: {:?}",
                e
            ));
        }
    };
    let p_action: IAction = match unsafe { p_action_collection.Create(TASK_ACTION_EXEC) } {
        Ok(p_action) => p_action,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Create failed: {:?}",
                e
            ));
        }
    };

    // 将 IAction 转换为 IExecAction
    let p_exec_action: IExecAction = match p_action.cast() {
        Ok(p_exec_action) => p_exec_action,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] cast failed: {:?}",
                e
            ));
        }
    };
    unsafe {
        let hr = p_exec_action.SetPath(&windows::core::BSTR::from(&*exe_path));
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] SetPath failed: {:?}",
                hr
            ));
        }
    }

    // 设置参数
    unsafe {
        let hr = p_exec_action.SetArguments(&windows::core::BSTR::from("--auto_start"));
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] SetArguments failed: {:?}",
                hr
            ));
        }
    }

    // 设置任务为以管理员权限运行
    // S-1-5-32-544 是管理员组的 SID
    let admin_sid = windows::core::BSTR::from("S-1-5-32-544");

    // 注册任务
    let _p_registered_task: IRegisteredTask = match unsafe {
        p_root_folder.RegisterTaskDefinition(
            &windows::core::BSTR::from(TASK_NAME),
            &p_task,
            TaskScheduler::TASK_CREATE_OR_UPDATE.0,
            &VARIANT::from(admin_sid), // 使用管理员组 SID
            &VARIANT::default(),
            TASK_LOGON_GROUP,
            &VARIANT::from(""),
        )
    } {
        Ok(p_registered_task) => p_registered_task,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] RegisterTaskDefinition failed: {:?}",
                e
            ));
        }
    };

    Ok(())
}

pub fn delete_admin_auto_start_task() -> Result<(), String> {
    let _com_guard = ComGuard {};

    // 初始化 COM
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] CoInitializeEx failed: {:?}",
                hr
            ));
        }
    }

    // 创建 Task Service 实例
    let p_service: ITaskService = match unsafe {
        CoCreateInstance(&TaskScheduler::TaskScheduler, None, CLSCTX_INPROC_SERVER)
    } {
        Ok(p_service) => p_service,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] CoCreateInstance failed: {:?}",
                e
            ));
        }
    };

    // 连接到 Task Service
    unsafe {
        let hr = p_service.Connect(
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
        );
        if hr.is_err() {
            return Err("[create_admin_auto_start_task] Connect failed".into());
        }
    }

    // 获取根任务文件夹
    let p_root_folder: ITaskFolder =
        match unsafe { p_service.GetFolder(&windows::core::BSTR::from("\\")) } {
            Ok(p_root_folder) => p_root_folder,
            Err(e) => {
                return Err(format!(
                    "[create_admin_auto_start_task] GetFolder failed: {:?}",
                    e
                ));
            }
        };

    // 删除已存在的同名任务
    let _ = unsafe { p_root_folder.DeleteTask(&windows::core::BSTR::from(TASK_NAME), 0) };

    Ok(())
}

pub fn is_admin_auto_start_task_enabled() -> Result<bool, String> {
    let _com_guard = ComGuard {};

    // 初始化 COM
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] CoInitializeEx failed: {:?}",
                hr
            ));
        }
    }

    // 创建 Task Service 实例
    let p_service: ITaskService = match unsafe {
        CoCreateInstance(&TaskScheduler::TaskScheduler, None, CLSCTX_INPROC_SERVER)
    } {
        Ok(p_service) => p_service,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] CoCreateInstance failed: {:?}",
                e
            ));
        }
    };

    // 连接到 Task Service
    unsafe {
        let hr = p_service.Connect(
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
        );
        if hr.is_err() {
            return Err("[create_admin_auto_start_task] Connect failed".into());
        }
    }

    // 获取根任务文件夹
    let p_root_folder: ITaskFolder =
        match unsafe { p_service.GetFolder(&windows::core::BSTR::from("\\")) } {
            Ok(p_root_folder) => p_root_folder,
            Err(e) => {
                return Err(format!(
                    "[create_admin_auto_start_task] GetFolder failed: {:?}",
                    e
                ));
            }
        };

    // 删除已存在的同名任务
    let task = match unsafe { p_root_folder.GetTask(&windows::core::BSTR::from(TASK_NAME)) } {
        Ok(task) => task,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] GetTask failed: {:?}",
                e
            ));
        }
    };

    let enabled = match unsafe { task.Enabled() } {
        Ok(enabled) => enabled,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Enabled failed: {:?}",
                e
            ));
        }
    };

    Ok(enabled.as_bool())
}

/// 检查当前进程是否具有管理员权限
pub fn is_admin() -> bool {
    unsafe {
        let mut token: HANDLE = HANDLE::default();
        let process = GetCurrentProcess();

        // 获取进程令牌
        if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_err() {
            return false;
        }

        // 检查令牌权限
        let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
        let mut return_length = 0u32;

        let result = GetTokenInformation(
            token,
            windows::Win32::Security::TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut return_length,
        );

        result.is_ok() && elevation.TokenIsElevated != 0
    }
}

/// 使用ShellExecuteEx请求UAC提权启动当前进程的新实例
pub fn restart_with_admin() -> Result<(), String> {
    // 先检查是否已经具有管理员权限
    if is_admin() {
        return Ok(());
    }

    // 获取当前可执行文件的路径
    let current_exe = match env::current_exe() {
        Ok(current_exe) => current_exe,
        Err(e) => {
            return Err(format!(
                "[restart_with_admin] env::current_exe failed: {:?}",
                e
            ));
        }
    };
    let exe_path = current_exe.to_string_lossy();

    unsafe {
        // 通过 cmd.exe 启动新进程并传入当前 PID，
        // 新进程会等待当前进程完全退出（释放单实例锁）后再初始化应用
        let cmd_args = format!(
            "/C \"\"{}\" --restart_wait_pid={}\"",
            exe_path,
            std::process::id()
        );

        let mut sei: SHELLEXECUTEINFOW = std::mem::zeroed();
        sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        sei.fMask = SEE_MASK_NOCLOSEPROCESS;
        let verb = "runas\0".encode_utf16().collect::<Vec<u16>>();
        let file = "cmd.exe\0".encode_utf16().collect::<Vec<u16>>();
        let args = cmd_args.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        sei.lpVerb = PCWSTR::from_raw(verb.as_ptr());
        sei.lpFile = PCWSTR::from_raw(file.as_ptr());
        sei.lpParameters = PCWSTR::from_raw(args.as_ptr());
        sei.nShow = windows::Win32::UI::WindowsAndMessaging::SW_HIDE.0 as i32;

        let result = ShellExecuteExW(&mut sei);
        if result.is_err() {
            return Err("[restart_with_admin] ShellExecuteExW failed".into());
        }

        // 检查是否成功提权
        if sei.hProcess.is_invalid() {
            return Err("[restart_with_admin] ShellExecuteExW failed".into());
        }

        // 如果提权成功，退出当前进程让单实例锁释放
        std::process::exit(0);
    }
}

/// 等待指定 PID 的进程退出（重启场景使用）。
///
/// 重启时新进程携带 `--restart_wait_pid=<旧进程PID>` 启动，在这里等待旧进程
/// 完全退出（单实例锁随进程退出释放）后再继续初始化应用，避免单实例机制
/// 将新实例误判为重复启动而自行退出。
///
/// * `max_wait_ms`：最长等待时间（毫秒）。返回是否确认进程已退出。
pub fn wait_for_process_exit(pid: u32, max_wait_ms: u64) -> bool {
    use std::time::Instant;
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    let start = Instant::now();
    loop {
        // OpenProcess 失败说明进程已不存在（单实例锁已释放）
        let handle = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
            Ok(handle) => handle,
            Err(_) => return true,
        };

        // 每次等待 100ms：返回 WAIT_OBJECT_0 表示进程已退出
        let wait_result = unsafe { WaitForSingleObject(handle, 100) };
        let _ = unsafe { CloseHandle(handle) };

        if wait_result == WAIT_OBJECT_0 {
            return true;
        }

        if start.elapsed().as_millis() as u64 >= max_wait_ms {
            log::warn!(
                "[wait_for_process_exit] timed out after {}ms waiting for pid {}",
                max_wait_ms,
                pid
            );
            return false;
        }
    }
}

/// 重启应用程序（不使用管理员权限）
pub fn restart() -> Result<(), String> {
    // 获取当前可执行文件的路径
    let current_exe = match env::current_exe() {
        Ok(current_exe) => current_exe,
        Err(e) => {
            return Err(format!(
                "[restart] env::current_exe failed: {:?}",
                e
            ));
        }
    };

    // 直接启动新进程并传入当前进程 PID，
    // 新进程会等待当前进程完全退出（释放单实例锁）后再初始化应用，
    // 避免固定延迟不足时旧进程尚未退出，导致新实例被单实例机制退出
    let current_pid = std::process::id();
    let spawn_result = std::process::Command::new(&current_exe)
        .arg(format!("--restart_wait_pid={}", current_pid))
        .spawn();

    if let Err(e) = spawn_result {
        return Err(format!("[restart] failed to spawn new process: {:?}", e));
    }

    // 退出当前进程，释放单实例锁；新进程在旧进程退出后自动继续启动
    std::process::exit(0);
}

/// 设置当前进程优先级（仅 Windows 有效）
///
/// enable 为 true 时设置为「高于正常」(ABOVE_NORMAL_PRIORITY_CLASS)，
/// 否则恢复为「正常」(NORMAL_PRIORITY_CLASS)。
/// 无需管理员权限。
pub fn set_process_priority(enable: bool) -> Result<(), String> {
    unsafe {
        let process = GetCurrentProcess();
        let priority_class = if enable {
            ABOVE_NORMAL_PRIORITY_CLASS
        } else {
            NORMAL_PRIORITY_CLASS
        };

        if SetPriorityClass(process, priority_class).is_err() {
            return Err("[set_process_priority] SetPriorityClass failed".into());
        }
    }

    Ok(())
}

/// 等待 Windows 桌面外壳就绪（用于开机自启场景）。
///
/// 登录早期外壳未初始化，创建 WebView2 会因 0x80070490 失败。
/// 轮询 `GetShellWindow` 直到就绪，外壳就绪后即可正常启动。
///
/// 注意：此处不要初始化 COM。本函数在主线程、tauri 初始化之前运行，
/// 若提前把 COM 初始化为 MTA 套间，tao 创建窗口时 OleInitialize 会报
/// RPC_E_CHANGED_MODE panic（GetShellWindow 本身也不需要 COM）。
///
/// * `max_wait_ms`：最长等待时间（毫秒）。返回是否在超时前就绪。
pub fn wait_for_desktop_ready(max_wait_ms: u64) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetShellWindow;
    use std::time::Duration;

    let start = std::time::Instant::now();
    let poll = Duration::from_millis(500);

    loop {
        // GetShellWindow 在非空时表示桌面外壳已存在、用户会话环境就绪。
        let shell_hwnd = unsafe { GetShellWindow() };
        if !shell_hwnd.is_invalid() {
            log::info!(
                "[wait_for_desktop_ready] desktop shell ready after {:?}",
                start.elapsed()
            );
            return true;
        }

        if start.elapsed().as_millis() as u64 >= max_wait_ms {
            log::warn!(
                "[wait_for_desktop_ready] timed out after {}ms waiting for desktop shell",
                max_wait_ms
            );
            return false;
        }

        std::thread::sleep(poll);
    }
}
