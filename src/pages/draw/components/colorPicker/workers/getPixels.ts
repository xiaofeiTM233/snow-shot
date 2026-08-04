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
		// 如果 worker 未初始化，自动创建
		if (!decodeWorker) {
			registerWebWorker();
		}

		if (!decodeWorker) {
			reject(new Error("getPixels: Failed to create decodeWorker"));
			return;
		}

		decodeWorker.onmessage = (event: MessageEvent<DecodeResult>) => {
			resolve(event.data);
		};

		decodeWorker.onerror = (error) => {
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
