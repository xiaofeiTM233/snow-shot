import { decode_to_rgba, initSync } from "turbo-png";

// 顶层全局错误监听：Worker 内的同步/异步崩溃（包括 wasm trap、
// new ImageData 失败、未捕获 rejection）默认只进 Worker 线程专属
// Console，主线程看不到。这里统一打出，便于定位崩溃点。
self.onerror = (event) => {
	console.error("[getPixelsWorker] onerror", {
		message: (event as ErrorEvent)?.message,
		filename: (event as ErrorEvent)?.filename,
		lineno: (event as ErrorEvent)?.lineno,
		colno: (event as ErrorEvent)?.colno,
		error: (event as ErrorEvent)?.error,
	});
};
self.onunhandledrejection = (event) => {
	console.error(
		"[getPixelsWorker] unhandledrejection",
		(event as PromiseRejectionEvent)?.reason,
	);
};

self.onmessage = async (
	event: MessageEvent<{
		wasmModuleArrayBuffer: ArrayBuffer;
		imageBuffer: ArrayBuffer;
	}>,
) => {
	const { imageBuffer, wasmModuleArrayBuffer } = event.data;

	// initSync 不可重复调用，多次调用可能导致 wasm 静默卡死。
	// 用 self 属性而非模块级变量，避免 rsbuild worker chunk 触发 TDZ。
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
		// 后 8 位包含图像的宽高
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
