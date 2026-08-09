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
	const data = event.data as { id?: number; result?: DecodeResult; error?: string };

	const id = data.id;
	const result = data.result;
	const error = data.error;

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
		// 超时即销毁 worker，避免卡死后请求堆积
		const timer = setTimeout(() => {
			pendingTasks.delete(id);
			terminateWebWorker();
			reject(new Error(`getPixels timeout (id=${id}): decodeWorker no response`));
		}, 3000);

		pendingTasks.set(id, { resolve, reject, timer });

		// transfer 所有权，减少拷贝
		worker.postMessage({ id, imageBuffer }, [imageBuffer]);
	});
}

export function terminateWebWorker() {
	if (decodeWorker) {
		decodeWorker.removeEventListener("message", handleWorkerMessage);
		decodeWorker.removeEventListener("error", handleWorkerError);
		decodeWorker.terminate();
		decodeWorker = undefined;
	}
	// 清理 pending 任务，避免内存泄漏
	for (const task of pendingTasks.values()) {
		clearTimeout(task.timer);
		task.reject(new Error("getPixels: worker terminated"));
	}
	pendingTasks.clear();
}
