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
        // 使用 cmd.exe 延迟启动新进程，确保旧进程有足够时间退出并释放单实例锁
        // ping 127.0.0.1 -n 2 大约延迟 1 秒
        let cmd_args = format!(
            "/C ping 127.0.0.1 -n 2 > nul && \"{}\"",
            exe_path
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
    let exe_path = current_exe.to_string_lossy();

    unsafe {
        // 使用 cmd.exe 延迟启动新进程，确保旧进程有足够时间退出并释放单实例锁
        // ping 127.0.0.1 -n 2 大约延迟 1 秒
        let cmd_args = format!(
            "/C ping 127.0.0.1 -n 2 > nul && \"{}\"",
            exe_path
        );

        let mut sei: SHELLEXECUTEINFOW = std::mem::zeroed();
        sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        sei.fMask = SEE_MASK_NOCLOSEPROCESS;
        let verb = "open\0".encode_utf16().collect::<Vec<u16>>();
        let file = "cmd.exe\0".encode_utf16().collect::<Vec<u16>>();
        let args = cmd_args.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        sei.lpVerb = PCWSTR::from_raw(verb.as_ptr());
        sei.lpFile = PCWSTR::from_raw(file.as_ptr());
        sei.lpParameters = PCWSTR::from_raw(args.as_ptr());
        sei.nShow = windows::Win32::UI::WindowsAndMessaging::SW_HIDE.0 as i32;

        let result = ShellExecuteExW(&mut sei);
        if result.is_err() {
            return Err("[restart] ShellExecuteExW failed".into());
        }

        // 检查是否成功启动
        if sei.hProcess.is_invalid() {
            return Err("[restart] ShellExecuteExW failed".into());
        }

        // 退出当前进程，让单实例锁释放
        std::process::exit(0);
    }
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
