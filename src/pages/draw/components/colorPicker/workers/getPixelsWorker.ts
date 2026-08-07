import { decode_to_rgba, initSync } from "turbo-png";

self.onmessage = async (
	event: MessageEvent<{
		wasmModuleArrayBuffer: ArrayBuffer;
		imageBuffer: ArrayBuffer;
	}>,
) => {
	const { imageBuffer, wasmModuleArrayBuffer } = event.data;

	// 错误监听仅在首次 onmessage 时注册，避免模块顶层赋值被 rsbuild 重排触发 TDZ
	if (!(self as any).__listenersInited) {
		(self as any).__listenersInited = true;

		self.onerror = (event: Event | string) => {
			const e = event as ErrorEvent;
			console.error("[getPixelsWorker] onerror", {
				message: e?.message,
				filename: e?.filename,
				lineno: e?.lineno,
				colno: e?.colno,
				error: e?.error,
			});
		};
		self.onunhandledrejection = (ev: PromiseRejectionEvent) => {
			console.error("[getPixelsWorker] unhandledrejection", ev?.reason);
		};
	}

	// initSync 不可重复调用，多次调用可能导致 wasm 静默卡死。
	if (!(self as any).__wasmInited) {
		try {
			initSync({
				module: wasmModuleArrayBuffer,
			});
			(self as any).__wasmInited = true;
		} catch (error) {
			console.error("getPixelsWorker initSync failed", {
				wasmByteLength: wasmModuleArrayBuffer?.byteLength,
				imageByteLength: imageBuffer?.byteLength,
				error,
			});
			throw error;
		}
	}

	let imageData: Uint8Array;
	try {
		imageData = decode_to_rgba(new Uint8Array(imageBuffer));
	} catch (error) {
		console.error("getPixelsWorker decode_to_rgba failed", {
			wasmByteLength: wasmModuleArrayBuffer?.byteLength,
			imageByteLength: imageBuffer?.byteLength,
			pngSignature: Array.from(new Uint8Array(imageBuffer.slice(0, 8))),
			error,
		});
		throw error;
	}

	const dataView = new DataView(imageData.buffer, imageData.byteLength - 8);
	const imageWidth = dataView.getUint32(0, true);
	const imageHeight = dataView.getUint32(4, true);

	self.postMessage({
		data: new ImageData(
			imageData.subarray(0, imageData.byteLength - 8) as ImageDataArray,
			imageWidth,
			imageHeight,
		),
		width: imageWidth,
		height: imageHeight,
	});
};
