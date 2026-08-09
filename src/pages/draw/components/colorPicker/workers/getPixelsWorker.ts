type RequestPayload = {
	id?: number;
	// wasmModuleArrayBuffer 已不再使用，保留字段仅为接口兼容
	wasmModuleArrayBuffer?: ArrayBuffer;
	imageBuffer: ArrayBuffer;
};

type SuccessResponse = {
	id?: number;
	result: {
		data: ImageData;
		width: number;
		height: number;
	};
};

type ErrorResponse = {
	id?: number;
	error: string;
};

// 顶层全局错误监听：Worker 内的同步/异步崩溃默认只进 Worker 线程专属
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

/**
 * 用浏览器原生 createImageBitmap 解码 PNG/任意图像格式为 RGBA 像素数据。
 *
 * 之前用 turbo-png 的 decode_to_rgba（wasm）解码，存在两个问题：
 * 1. 对非 RGB/RGBA 的 PNG 有内存越界 bug，会触发 wasm trap，导致 worker
 *    静默卡死（trap 不被 try/catch 捕获，wasm 实例直接损坏无法再调用）
 * 2. wasm 模块的加载/初始化在某些用户环境下可能失败，且失败后原版
 *    __initPromise 永久缓存 rejected 状态，导致后续所有解码都死锁
 *
 * 浏览器原生 createImageBitmap + OffscreenCanvas 方案：
 * - 支持所有标准图像格式（PNG 所有 color type / bit depth / interlacing、
 *   WebP、JPEG、BMP 等）
 * - 绝不会 trap，任何格式错误都会抛 JS 异常被 try/catch 捕获
 * - 不依赖 wasm，消除了 wasm 加载/初始化的所有环境相关问题
 * - WebView2 138 完全支持 createImageBitmap 和 OffscreenCanvas
 */
async function decodeWithBrowser(
	imageBuffer: ArrayBuffer,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
	const blob = new Blob([imageBuffer], { type: "image/png" });
	const bitmap = await createImageBitmap(blob);
	const width = bitmap.width;
	const height = bitmap.height;

	const offscreen = new OffscreenCanvas(width, height);
	const ctx = offscreen.getContext("2d", { willReadFrequently: true });
	if (!ctx) {
		bitmap.close();
		throw new Error("decodeWithBrowser: failed to get 2d context");
	}

	ctx.drawImage(bitmap, 0, 0);
	bitmap.close();

	const imageData = ctx.getImageData(0, 0, width, height);
	return { data: imageData.data, width, height };
}

self.onmessage = async (event: MessageEvent<RequestPayload>) => {
	const { id, imageBuffer } = event.data;

	const fail = (message: string) => {
		const resp: ErrorResponse = { id, error: message };
		self.postMessage(resp);
	};

	// 解码：用浏览器原生 createImageBitmap（支持所有 PNG 格式，不会 trap）
	let rgbaData: Uint8ClampedArray;
	let imageWidth: number;
	let imageHeight: number;

	try {
		const decoded = await decodeWithBrowser(imageBuffer);
		rgbaData = decoded.data;
		imageWidth = decoded.width;
		imageHeight = decoded.height;
	} catch (error) {
		console.error("[getPixelsWorker] decodeWithBrowser failed", {
			imageByteLength: imageBuffer?.byteLength,
			pngSignature: Array.from(new Uint8Array(imageBuffer.slice(0, 8))),
			error,
		});
		fail(`decode failed: ${(error as Error)?.message ?? String(error)}`);
		return;
	}

	// 构造 ImageData 并回传
	try {
		// 复制到独立 buffer 以便 transfer 所有权，避免结构化克隆拷贝大图
		const pixelBuffer = rgbaData.buffer.slice(0, rgbaData.byteLength);

		const result: SuccessResponse = {
			id,
			result: {
				data: new ImageData(
					new Uint8ClampedArray(pixelBuffer),
					imageWidth,
					imageHeight,
				),
				width: imageWidth,
				height: imageHeight,
			},
		};
		self.postMessage(result, [pixelBuffer]);
	} catch (error) {
		fail(
			`build ImageData failed: ${(error as Error)?.message ?? String(error)}`,
		);
	}
};
