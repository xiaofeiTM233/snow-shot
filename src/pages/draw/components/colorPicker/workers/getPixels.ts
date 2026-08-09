export type DecodeResult = {
	data: ImageData;
	width: number;
	height: number;
};

let decodeWorker: Worker | undefined;

export function registerWebWorker() {
	try {
		decodeWorker = new Worker(new URL("./getPixelsWorker.ts", import.meta.url));
	} catch (error) {
		console.error("Failed to create decodeWorker:", error);
	}
}

export async function getPixels(
	wasmModuleArrayBuffer: ArrayBuffer,
	imageBuffer: ArrayBuffer,
): Promise<DecodeResult> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			// 超时说明 worker 静默卡死（wasm trap），kill 重建
			decodeWorker?.terminate();
			decodeWorker = undefined;
			reject(new Error("getPixels timeout: decodeWorker no response"));
		}, 800);

		// 如果 worker 未初始化，自动创建
		if (!decodeWorker) {
			registerWebWorker();
		}

		if (!decodeWorker) {
			clearTimeout(timer);
			reject(new Error("getPixels: Failed to create decodeWorker"));
			return;
		}

		// 用一次性 listener 而非覆盖式 onmessage：避免并发调用 getPixels 时
		// 后一次覆盖前一次的回调，导致前一次的 Promise 永久 pending（进而切换历史干等超时）
		const handleDecodeMessage = (event: MessageEvent<DecodeResult>) => {
			clearTimeout(timer);
			decodeWorker?.removeEventListener("message", handleDecodeMessage);
			resolve(event.data);
		};

		decodeWorker.addEventListener("message", handleDecodeMessage);

		decodeWorker.onerror = (error) => {
			clearTimeout(timer);
			decodeWorker?.removeEventListener("message", handleDecodeMessage);
			reject(error);
		};

		// wasm module buffer 在 worker 内 initSync 时可能被底层引擎 detached/消费，
		// 复用全局单例会导致后续解码全部失败。每次传独立拷贝避免污染原 buffer。
		decodeWorker.postMessage({
			imageBuffer,
			wasmModuleArrayBuffer: wasmModuleArrayBuffer.slice(),
		});
	});
}

export function terminateWebWorker() {
	if (decodeWorker) {
		decodeWorker.terminate();
		decodeWorker = undefined;
	}
}
