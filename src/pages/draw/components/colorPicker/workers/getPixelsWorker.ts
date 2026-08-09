import { decode_to_rgba, initSync } from "turbo-png";

type RequestPayload = {
	id?: number;
	wasmModuleArrayBuffer: ArrayBuffer;
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

// 标记 wasm 是否已成功初始化。失败时清空，允许下次重试，
// 避免 rejected promise 永久缓存导致后续所有调用都死锁无响应。
let wasmInitialized = false;
let initPromise: Promise<void> | undefined;

async function ensureWasmInit(wasmModuleArrayBuffer: ArrayBuffer): Promise<void> {
	if (wasmInitialized) return;
	if (!initPromise) {
		initPromise = (async () => {
			try {
				initSync({ module: wasmModuleArrayBuffer });
				wasmInitialized = true;
			} catch (error) {
				// 诊断：wasm 实例化失败，通常是 wasmModuleArrayBuffer 已 detached/损坏
				console.error("getPixelsWorker initSync failed", {
					wasmByteLength: wasmModuleArrayBuffer?.byteLength,
					error,
				});
				// 关键：清空 initPromise，允许下次重试，避免永久死锁
				initPromise = undefined;
				throw error;
			}
		})();
	}
	await initPromise;
}

self.onmessage = async (event: MessageEvent<RequestPayload>) => {
	const { id, imageBuffer, wasmModuleArrayBuffer } = event.data;

	const fail = (message: string) => {
		const resp: ErrorResponse = { id, error: message };
		self.postMessage(resp);
	};

	// 1. wasm 初始化（失败时回传错误，绝不静默）
	try {
		await ensureWasmInit(wasmModuleArrayBuffer);
	} catch (error) {
		fail(`initSync failed: ${(error as Error)?.message ?? String(error)}`);
		return;
	}

	// 2. 解码
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
		fail(`decode_to_rgba failed: ${(error as Error)?.message ?? String(error)}`);
		return;
	}

	// 3. 解析宽高并回传
	try {
		const dataView = new DataView(imageData.buffer, imageData.byteLength - 8);
		const imageWidth = dataView.getUint32(0, true);
		const imageHeight = dataView.getUint32(4, true);

		const result: SuccessResponse = {
			id,
			result: {
				data: new ImageData(
					imageData.subarray(0, imageData.byteLength - 8) as ImageDataArray,
					imageWidth,
					imageHeight,
				),
				width: imageWidth,
				height: imageHeight,
			},
		};
		self.postMessage(result);
	} catch (error) {
		fail(
			`build ImageData failed: ${(error as Error)?.message ?? String(error)}`,
		);
	}
};
