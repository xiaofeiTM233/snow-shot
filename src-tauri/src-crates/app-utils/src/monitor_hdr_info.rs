use std::collections::HashMap;

use widestring::U16CString;
use windows::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
    DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO,
    DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO_0, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SDR_WHITE_LEVEL, DISPLAYCONFIG_SOURCE_DEVICE_NAME, DisplayConfigGetDeviceInfo,
    GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
};
use windows::Win32::Graphics::Gdi::DISPLAYCONFIG_COLOR_ENCODING;

/// 获取显示器的 SDR 白电平
fn get_sdr_white_level_for_adapter(
    adapter_id: windows::Win32::Foundation::LUID,
    target_id: u32,
) -> Result<u32, String> {
    // 创建 SDR 白电平信息结构体
    let mut sdr_white_level_info = DISPLAYCONFIG_SDR_WHITE_LEVEL {
        header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
            size: u32::try_from(std::mem::size_of::<DISPLAYCONFIG_SDR_WHITE_LEVEL>()).unwrap(),
            adapterId: adapter_id,
            id: target_id,
        },
        SDRWhiteLevel: 0,
    };

    if unsafe { DisplayConfigGetDeviceInfo(&mut sdr_white_level_info.header) } == 0 {
        Ok(sdr_white_level_info.SDRWhiteLevel)
    } else {
        Err(format!(
            "[get_sdr_white_level_for_adapter] Failed to get SDR white level"
        ))
    }
}

/// SDR 显示器信息结构体
#[derive(Debug, Clone)]
pub struct MonitorHdrInfo {
    pub sdr_white_level: u32,
    pub hdr_enabled: bool,
}

impl Default for MonitorHdrInfo {
    fn default() -> Self {
        Self {
            sdr_white_level: 0,
            hdr_enabled: false,
        }
    }
}

/// 获取显示器信息
pub fn get_all_monitors_sdr_info() -> Result<HashMap<String, MonitorHdrInfo>, String> {
    // 获取显示配置缓冲区大小
    let mut number_of_paths = 0;
    let mut number_of_modes = 0;
    match unsafe {
        GetDisplayConfigBufferSizes(
            QDC_ONLY_ACTIVE_PATHS,
            &mut number_of_paths,
            &mut number_of_modes,
        )
        .ok()
    } {
        Ok(_) => (),
        Err(e) => {
            return Err(format!(
                "[get_all_monitors_sdr_info] Failed to get display config buffer sizes: {}",
                e
            ));
        }
    }

    if number_of_paths == 0 {
        return Err(format!(
            "[get_all_monitors_sdr_info] No display paths found"
        ));
    }

    // 获取显示配置路径和模式
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); number_of_paths as usize];
    let mut modes = vec![
        windows::Win32::Devices::Display::DISPLAYCONFIG_MODE_INFO::default();
        number_of_modes as usize
    ];

    match unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut number_of_paths,
            paths.as_mut_ptr(),
            &mut number_of_modes,
            modes.as_mut_ptr(),
            None,
        )
        .ok()
    } {
        Ok(_) => (),
        Err(e) => {
            return Err(format!(
                "[get_all_monitors_sdr_info] Failed to get display config: {}",
                e
            ));
        }
    }

    // 为每个显示路径获取 SDR 信息
    let mut result = HashMap::new();

    for path in paths {
        // 获取源设备名称
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: u32::try_from(std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>())
                    .unwrap(),
                adapterId: path.sourceInfo.adapterId,
                id: path.sourceInfo.id,
            },
            viewGdiDeviceName: [0; 32],
        };

        let device_name = if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } == 0 {
            match U16CString::from_vec_truncate(source.viewGdiDeviceName).to_string() {
                Ok(name) => name,
                Err(e) => {
                    return Err(format!(
                        "[get_all_monitors_sdr_info] Failed to get device name: {:?}",
                        e
                    ));
                }
            }
        } else {
            return Err(format!(
                "[get_all_monitors_sdr_info] Failed to DisplayConfigGetDeviceInfo"
            ));
        };

        // 获取高级颜色信息
        let mut advanced_color_info = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
                size: u32::try_from(std::mem::size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>())
                    .unwrap(),
                adapterId: path.targetInfo.adapterId,
                id: path.targetInfo.id,
            },
            Anonymous: DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO_0 { value: 0 },
            colorEncoding: DISPLAYCONFIG_COLOR_ENCODING::default(),
            bitsPerColorChannel: 0,
        };

        let hdr_enabled =
            if unsafe { DisplayConfigGetDeviceInfo(&mut advanced_color_info.header) } == 0 {
                let value = unsafe { advanced_color_info.Anonymous.value };
                let hdr_enabled = (value & 0x2) != 0;

                hdr_enabled
            } else {
                false
            };

        // 获取 SDR 白电平
        let sdr_white_level =
            match get_sdr_white_level_for_adapter(path.targetInfo.adapterId, path.targetInfo.id) {
                Ok(level) => level,
                Err(_) => 1000, // 默认 SDR 白电平
            };

        result.insert(
            device_name,
            MonitorHdrInfo {
                sdr_white_level,
                hdr_enabled,
            },
        );
    }

    Ok(result)
}
