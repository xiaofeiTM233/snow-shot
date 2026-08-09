export type DecodeResult = {
	data: ImageData;
	width: number;
	height: number;
};

type PendingTask = {
	resolve: (value: DecodeResult) => void;
	reject: (reason: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
};

// 自增 id，用于匹配请求与响应，避免一次性 listener 在并发场景下错位
let taskIdSeq = 0;
let decodeWorker: Worker | undefined;
// pending 表：worker 单线程串行处理消息，按 id 取出对应 Promise 的 resolver
const pendingTasks = new Map<number, PendingTask>();

const handleWorkerMessage = (event: MessageEvent) => {
	// 支持两种协议：
	//   1. { id, result } / { id, error }   —— 新协议，带 id 透传
	//   2. DecodeResult（无 id）             —— 旧协议兜底，取最早入队任务
	const data = event.data as
		| { id?: number; result?: DecodeResult; error?: string }
		| DecodeResult;

	let id: number | undefined;
	let result: DecodeResult | undefined;
	let error: string | undefined;

	if (data && typeof data === "object" && ("result" in data || "error" in data)) {
		id = data.id;
		result = data.result;
		error = data.error;
	} else {
		// 兜底：取最早入队的任务
		const firstKey = pendingTasks.keys().next().value;
		if (firstKey === undefined) return;
		id = firstKey;
		result = data as DecodeResult;
	}

	if (id === undefined) return;
	const task = pendingTasks.get(id);
	if (!task) return;

	clearTimeout(task.timer);
	pendingTasks.delete(id);

	if (error) {
		task.reject(new Error(error));
	} else if (result) {
		task.resolve(result);
	} else {
		task.reject(new Error("getPixels: empty worker response"));
	}
};

const handleWorkerError = (event: ErrorEvent) => {
	// worker 抛出未捕获错误：fail-fast，reject 所有 pending 任务并销毁 worker
	console.error("[getPixels] decodeWorker onerror", {
		message: event?.message,
		filename: event?.filename,
		lineno: event?.lineno,
	});
	terminateWebWorker();
	for (const task of pendingTasks.values()) {
		clearTimeout(task.timer);
		task.reject(
			new Error(`getPixels: worker error: ${event?.message ?? "unknown"}`),
		);
	}
	pendingTasks.clear();
};

export function registerWebWorker() {
	if (decodeWorker) return;
	try {
		const worker = new Worker(new URL("./getPixelsWorker.ts", import.meta.url));
		worker.addEventListener("message", handleWorkerMessage);
		worker.addEventListener("error", handleWorkerError);
		decodeWorker = worker;
	} catch (error) {
		console.error("Failed to create decodeWorker:", error);
	}
}

export async function getPixels(
	wasmModuleArrayBuffer: ArrayBuffer,
	imageBuffer: ArrayBuffer,
): Promise<DecodeResult> {
	// 如果 worker 未初始化，自动创建
	if (!decodeWorker) {
		registerWebWorker();
	}
	if (!decodeWorker) {
		throw new Error("getPixels: Failed to create decodeWorker");
	}

	const id = ++taskIdSeq;
	const worker = decodeWorker;

	return new Promise((resolve, reject) => {
		// 超时：worker 静默卡死（wasm trap 或脚本错误未抛出），kill 重建
		const timer = setTimeout(() => {
			pendingTasks.delete(id);
			// 整个 worker 可能已经卡死，直接销毁，避免后续请求继续堆积
			terminateWebWorker();
			reject(new Error(`getPixels timeout (id=${id}): decodeWorker no response`));
		}, 3000);

		pendingTasks.set(id, { resolve, reject, timer });

		// wasm module buffer 在 worker 内 initSync 时可能被底层引擎 detached/消费，
		// 复用全局单例会导致后续解码全部失败。每次传独立拷贝避免污染原 buffer。
		const wasmCopy = wasmModuleArrayBuffer.slice();
		worker.postMessage(
			{
				id,
				imageBuffer,
				wasmModuleArrayBuffer: wasmCopy,
			},
			// 用 transfer list 转移 buffer 所有权，减少拷贝开销
			// 注意：wasmModuleArrayBuffer 已 slice 出独立副本 wasmCopy，可安全 transfer
			[imageBuffer, wasmCopy],
		);
	});
}

export function terminateWebWorker() {
	if (decodeWorker) {
		decodeWorker.removeEventListener("message", handleWorkerMessage);
		decodeWorker.removeEventListener("error", handleWorkerError);
		decodeWorker.terminate();
		decodeWorker = undefined;
	}
	// 清理所有 pending 任务，避免内存泄漏与永久 pending 的 Promise
	for (const task of pendingTasks.values()) {
		clearTimeout(task.timer);
		task.reject(new Error("getPixels: worker terminated"));
	}
	pendingTasks.clear();
}
