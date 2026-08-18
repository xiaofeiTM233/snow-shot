use dashmap::DashMap;
use std::ptr::NonNull;
use std::sync::mpsc::channel;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE, ICoreWebView2, ICoreWebView2Environment,
    ICoreWebView2Environment12, ICoreWebView2_17, ICoreWebView2SharedBuffer,
};
use windows_core::Interface;
// wry 的 COM 对象来自 windows-core 0.61 体系，需访问其 Interface::as_raw。
// 通过 rename 依赖引入，避免与本 crate 的 windows-core 0.62 同名冲突。
use windows_core_061::Interface as Interface061;

/// wry 给的 COM 对象来自 webview2-com 0.38（windows 0.61 体系），
/// 而本项目需要 cast 到 webview2-com 0.39（windows 0.62 体系）才导出的
/// ICoreWebView2Environment12 / ICoreWebView2_17 等扩展接口。
///
/// 安全桥接：先用 0.61 的 `Interface::as_raw` 取出底层 COM 指针，
/// 再用 0.62 的 `InterfaceRef`（借用、无 Drop，不调用 AddRef/Release）
/// 直接 `cast` 到目标扩展接口。`cast` 内部通过 QueryInterface 增加引用计数，
/// 返回的扩展接口拥有对象析构时 `Release` 一次，二者正好抵消；
/// 而 `InterfaceRef` 借用的原始指针**不会被 release**，因此 wry 持有的
/// 0.61 原始 COM 对象引用计数始终保持完整，避免了过早释放
/// （use-after-free / double-free）导致的崩溃。
fn to_062_environment<T: Interface061 + ?Sized>(
    env: &T,
) -> Option<windows_core::InterfaceRef<'static, ICoreWebView2Environment>> {
    let raw = Interface061::as_raw(env);
    NonNull::new(raw).map(|ptr| unsafe { windows_core::InterfaceRef::from_raw(ptr) })
}

fn to_062_core_webview<T: Interface061 + ?Sized>(
    core: &T,
) -> Option<windows_core::InterfaceRef<'static, ICoreWebView2>> {
    let raw = Interface061::as_raw(core);
    NonNull::new(raw).map(|ptr| unsafe { windows_core::InterfaceRef::from_raw(ptr) })
}

pub async fn create_shared_buffer(
    webview: tauri::Webview,
    data: &[u8],
    extra_data: &[u8],
    transfer_type: String,
) -> Result<(), String> {
    // windows 可以使用 SharedBuffer 加快数据传输
    let (transfer_result_sender, transfer_result_receiver) = channel::<Result<(), String>>();
    // 使用 unsafe 将引用转换为 'static 生命周期，因为保证数据在 with_webview 执行期间有效
    let data_static: &'static [u8] = unsafe { std::mem::transmute(data) };
    let extra_data_static: &'static [u8] = unsafe { std::mem::transmute(extra_data) };

    let sender = transfer_result_sender.clone();
    match webview.with_webview(move |webview| {
        let environment = webview.environment();

        let core_webview = match unsafe { webview.controller().CoreWebView2() } {
            Ok(core_webview) => core_webview,
            Err(e) => {
                sender
                    .send(Err(format!(
                        "[create_shared_buffer] Failed to get core webview: {:?}",
                        e
                    )))
                    .unwrap();
                return;
            }
        };

        let enviroment_12 = match to_062_environment(&environment)
            .expect("null environment pointer")
            .cast::<ICoreWebView2Environment12>()
        {
            Ok(environment) => environment,
            Err(e) => {
                sender
                    .send(Err(format!(
                        "[create_shared_buffer] Failed to create shared buffer: {:?}",
                        e
                    )))
                    .unwrap();
                return;
            }
        };

        let data_len = data_static.len() + extra_data_static.len();
        let shared_buffer = match unsafe { enviroment_12.CreateSharedBuffer(data_len as u64) } {
            Ok(sharedbuffer) => sharedbuffer,
            Err(e) => {
                sender
                    .send(Err(format!(
                        "[create_shared_buffer] Failed to create shared buffer: {:?}",
                        e
                    )))
                    .unwrap();
                return;
            }
        };

        let mut shared_buffer_ptr: *mut u8 = 0 as *mut u8;
        match unsafe { shared_buffer.Buffer(&mut shared_buffer_ptr) } {
            Ok(_) => (),
            Err(e) => {
                sender
                    .send(Err(format!(
                        "[create_shared_buffer] Failed to buffer shared buffer: {:?}",
                        e
                    )))
                    .unwrap();
                return;
            }
        };

        let webview_17 = match to_062_core_webview(&core_webview)
            .expect("null core webview pointer")
            .cast::<ICoreWebView2_17>()
        {
            Ok(environment) => environment,
            Err(e) => {
                sender
                    .send(Err(format!(
                        "[create_shared_buffer] Failed to cast to ICoreWebView2_17: {:?}",
                        e
                    )))
                    .unwrap();
                return;
            }
        };

        // 将数据拷贝到 shared_buffer
        unsafe {
            std::ptr::copy_nonoverlapping(
                data_static.as_ptr(),
                shared_buffer_ptr,
                data_static.len(),
            );
            std::ptr::copy_nonoverlapping(
                extra_data_static.as_ptr(),
                shared_buffer_ptr.add(data_static.len()),
                extra_data_static.len(),
            );
        }

        let additional_data_string: Vec<u16> =
            format!("{{\"transfer_type\":\"{}\"}}", transfer_type)
                .encode_utf16()
                .chain(std::iter::once(0)) // null terminator
                .collect();
        let additional_data = windows::core::PCWSTR::from_raw(additional_data_string.as_ptr());

        match unsafe {
            webview_17.PostSharedBufferToScript(
                &shared_buffer,
                COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
                additional_data,
            )
        } {
            Ok(_) => {
                sender.send(Ok(())).unwrap();
            }
            Err(e) => {
                sender
                    .send(Err(format!(
                        "[create_shared_buffer] Failed to post shared buffer to script: {:?}",
                        e
                    )))
                    .unwrap();
            }
        };
    }) {
        Ok(_) => {}
        Err(e) => {
            transfer_result_sender
                .send(Err(format!(
                    "[create_shared_buffer] Failed to create shared buffer: {:?}",
                    e
                )))
                .unwrap();
        }
    }

    let result = match transfer_result_receiver.recv() {
        Ok(result) => result,
        Err(_) => {
            return Err(format!(
                "[create_shared_buffer] Failed to receive transfer result",
            ));
        }
    };

    result?;

    Ok(())
}

pub struct SharedBufferContainer(ICoreWebView2SharedBuffer);

unsafe impl Send for SharedBufferContainer {}
unsafe impl Sync for SharedBufferContainer {}

pub struct SharedBufferChannel {
    buffer: SharedBufferContainer,
    buffer_size: usize,
}

/// 用于和 JavaScript 通过 SharedBuffer 传递数据
pub struct SharedBufferService {
    channel_map: DashMap<String, SharedBufferChannel>,
}

impl SharedBufferService {
    pub fn new() -> Self {
        Self {
            channel_map: DashMap::new(),
        }
    }

    /// 创建一条通道，通过唯一 ID 和 JavaScript 通信
    pub fn create_channel(
        &self,
        id: String,
        webview: tauri::Webview,
        data_size: usize,
    ) -> Result<(), String> {
        // 通过 WebView 创建 SharedBuffer，获取 SharedBuffer 的内存地址
        let (shared_buffer_address_sender, shared_buffer_address_receiver) =
            channel::<Result<SharedBufferContainer, String>>();

        let sender = shared_buffer_address_sender.clone();
        let id_clone = id.clone();
        match webview.with_webview(move |webview| {
            let environment = webview.environment();

            let core_webview = match unsafe { webview.controller().CoreWebView2() } {
                Ok(core_webview) => core_webview,
                Err(e) => {
                    sender
                        .send(Err(format!(
                            "[SharedBufferService::create_channel] Failed to get core webview: {:?}",
                            e
                        )))
                        .unwrap();
                    return;
                }
            };

            let enviroment_12 = match to_062_environment(&environment)
            .expect("null environment pointer")
            .cast::<ICoreWebView2Environment12>()
        {
                Ok(environment) => environment,
                Err(e) => {
                    sender
                        .send(Err(format!(
                            "[SharedBufferService::create_channel] Failed to create shared buffer: {:?}",
                            e
                        )))
                        .unwrap();
                    return;
                }
            };

            let shared_buffer = match unsafe { enviroment_12.CreateSharedBuffer(data_size as u64) } {
                Ok(sharedbuffer) => sharedbuffer,
                Err(e) => {
                    sender
                        .send(Err(format!(
                            "[SharedBufferService::create_channel] Failed to create shared buffer: {:?}",
                            e
                        )))
                        .unwrap();
                    return;
                }
            };


            let webview_17 = match to_062_core_webview(&core_webview)
            .expect("null core webview pointer")
            .cast::<ICoreWebView2_17>()
        {
                Ok(environment) => environment,
                Err(e) => {
                    sender
                        .send(Err(format!(
                            "[create_shared_buffer] Failed to cast to ICoreWebView2_17: {:?}",
                            e
                        )))
                        .unwrap();
                    return;
                }
            };

            // Keep the UTF-16 string alive until after PostSharedBufferToScript
            let channel_info_string: Vec<u16> = format!("{{\"id\":\"{}\"}}", id_clone)
                .encode_utf16()
                .chain(std::iter::once(0)) // null terminator
                .collect();
            let channel_info = windows::core::PCWSTR::from_raw(channel_info_string.as_ptr());

            match unsafe {
                webview_17.PostSharedBufferToScript(
                    &shared_buffer,
                    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
                    channel_info,
                )
            } {
                Ok(_) => {
                    sender.send(Ok(SharedBufferContainer(shared_buffer))).unwrap();
                }
                Err(e) => {
                    sender
                        .send(Err(format!(
                            "[SharedBufferService::create_channel] Failed to post shared buffer to script: {:?}",
                            e
                        )))
                        .unwrap();
                }
            };
        }) {
            Ok(_) => {}
            Err(e) => {
                shared_buffer_address_sender
                    .send(Err(format!(
                        "[SharedBufferService::create_channel] Failed to create shared buffer: {:?}",
                        e
                    )))
                    .unwrap();
            }
        }

        let result = match shared_buffer_address_receiver.recv() {
            Ok(result) => result,
            Err(_) => {
                return Err(format!(
                    "[SharedBufferService::create_channel] Failed to receive shared buffer address",
                ));
            }
        };

        let buffer = result?;

        self.channel_map.insert(
            id,
            SharedBufferChannel {
                buffer,
                buffer_size: data_size,
            },
        );

        Ok(())
    }

    pub fn receive_data(&self, id: String) -> Result<Vec<u8>, String> {
        let (_, channel) = match self.channel_map.remove(&id) {
            Some(channel) => channel,
            None => {
                return Err(format!(
                    "[SharedBufferService::receive_data] Channel not found: {}",
                    id
                ));
            }
        };

        let mut data = unsafe {
            let mut array = Vec::with_capacity(channel.buffer_size);
            array.set_len(channel.buffer_size);
            array
        };

        let mut shared_buffer_ptr: *mut u8 = 0 as *mut u8;
        match unsafe { channel.buffer.0.Buffer(&mut shared_buffer_ptr) } {
            Ok(_) => (),
            Err(e) => {
                return Err(format!(
                    "[SharedBufferService::receive_data] Failed to buffer shared buffer: {:?}",
                    e
                ));
            }
        };

        unsafe {
            std::ptr::copy_nonoverlapping(
                shared_buffer_ptr,
                data.as_mut_ptr(),
                channel.buffer_size,
            );
        }

        match unsafe { channel.buffer.0.Close() } {
            Ok(_) => (),
            Err(e) => {
                return Err(format!(
                    "[SharedBufferService::receive_data] Failed to close shared buffer: {:?}",
                    e
                ));
            }
        };

        Ok(data)
    }
}
