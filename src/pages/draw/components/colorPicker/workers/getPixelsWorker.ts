import { decode_to_rgba, initSync } from "turbo-png";

// 顶层全局错误监听：Worker 内的同步/异步崩溃（包括 wasm trap、
// new ImageData 失败、未捕获 rejection）默认只进 Worker 线程专属
// Console，主线程 Console 看不到。这里统一打出，便于定位崩溃点。
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

	try {
		initSync({
			module: wasmModuleArrayBuffer,
		});
	} catch (error) {
		// 诊断：wasm 实例化失败，通常是 wasmModuleArrayBuffer 已 detached/损坏
		console.error("getPixelsWorker initSync failed", {
			wasmByteLength: wasmModuleArrayBuffer?.byteLength,
			imageByteLength: imageBuffer?.byteLength,
			error,
		});
		throw error;
	}

	let imageData: Uint8Array;
	try {
		// 后 8 位包含图像的宽高
		imageData = decode_to_rgba(new Uint8Array(imageBuffer));
	} catch (error) {
		// 诊断：解码失败，通常是 imageBuffer 不是合法 PNG 或文件损坏
		console.error("getPixelsWorker decode_to_rgba failed", {
			wasmByteLength: wasmModuleArrayBuffer?.byteLength,
			imageByteLength: imageBuffer?.byteLength,
			// 打印 PNG 文件头签名（前 8 字节）便于判断是否为合法 PNG
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
