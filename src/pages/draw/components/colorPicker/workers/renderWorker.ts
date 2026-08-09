import type { RefType } from "@/components/imageLayer/baseLayerRenderActions";
import {
	renderGetPreviewImageDataAction,
	renderInitImageDataAction,
	renderInitPreviewCanvasAction,
	renderPickColorAction,
	renderPutImageDataAction,
	renderSwitchCaptureHistoryAction,
} from "../renderActions";
import { terminateWebWorker } from "./getPixels";
import {
	type ColorPickerRenderData,
	type ColorPickerRenderInitImageDataData,
	type ColorPickerRenderInitPreviewCanvasData,
	ColorPickerRenderMessageType,
	type ColorPickerRenderPickColorData,
	type ColorPickerRenderPutImageDataData,
	type ColorPickerRenderResult,
	type ColorPickerRenderSwitchCaptureHistoryResult,
	type ColorPickerRenderSwitchCaptureHistoryData,
} from "./renderWorkerTypes";

const previewCanvasRef: RefType<OffscreenCanvas | null> = {
	current: null,
};
const previewCanvasCtxRef: RefType<OffscreenCanvasRenderingContext2D | null> = {
	current: null,
};
const previewImageDataRef: RefType<ImageData | null> = {
	current: null,
};
const captureHistoryImageDataRef: RefType<ImageData | undefined> = {
	current: undefined,
};

const handleInitPreviewCanvas = async (
	data: ColorPickerRenderInitPreviewCanvasData,
) => {
	const { previewCanvas } = data.payload;

	renderInitPreviewCanvasAction(
		previewCanvasRef,
		previewCanvas,
		previewCanvasCtxRef,
	);
};

const handleInitImageData = async (
	data: ColorPickerRenderInitImageDataData,
) => {
	const { imageBuffer } = data.payload;
	await renderInitImageDataAction(
		previewCanvasRef,
		previewImageDataRef,
		imageBuffer,
	);
};

const handlePutImageData = async (data: ColorPickerRenderPutImageDataData) => {
	const { x, y, colorX, colorY, centerAuxiliaryLineColor } = data.payload;
	return renderPutImageDataAction(
		previewCanvasCtxRef,
		previewImageDataRef,
		captureHistoryImageDataRef,
		x,
		y,
		colorX,
		colorY,
		centerAuxiliaryLineColor,
	);
};

const handleGetPreviewImageData = async () => {
	return renderGetPreviewImageDataAction(
		previewImageDataRef,
		captureHistoryImageDataRef,
	);
};

const handleSwitchCaptureHistory = async (
	data: ColorPickerRenderSwitchCaptureHistoryData,
) => {
	const { imageSrc } = data.payload;
	try {
		await renderSwitchCaptureHistoryAction(
			captureHistoryImageDataRef,
			imageSrc,
		);
	} catch (error) {
		// 解码失败时不崩溃 worker，保留上一张有效数据
		console.warn("handleSwitchCaptureHistory error", error);
	} finally {
		// 无论成功失败都回传结果，避免 switchCaptureHistoryAction 干等超时
		const result: ColorPickerRenderSwitchCaptureHistoryResult = {
			type: ColorPickerRenderMessageType.SwitchCaptureHistory,
			payload: undefined,
		};
		self.postMessage(result);
	}
};

const handlePickColor = async (data: ColorPickerRenderPickColorData) => {
	const { x, y } = data.payload;
	return renderPickColorAction(
		captureHistoryImageDataRef,
		previewImageDataRef,
		x,
		y,
	);
};

// 处理单条消息，返回是否已自行回传结果（SwitchCaptureHistory 在 finally 里回传）
const processMessage = async (
	data: ColorPickerRenderData,
): Promise<boolean> => {
	let message: ColorPickerRenderResult;
	switch (data.type) {
		case ColorPickerRenderMessageType.InitPreviewCanvas:
			await handleInitPreviewCanvas(data);
			message = {
				type: ColorPickerRenderMessageType.InitPreviewCanvas,
				payload: undefined,
			};
			break;
		case ColorPickerRenderMessageType.InitImageData:
			await handleInitImageData(data);
			message = {
				type: ColorPickerRenderMessageType.InitImageData,
				payload: undefined,
			};
			break;
		case ColorPickerRenderMessageType.PutImageData: {
			const color = await handlePutImageData(data);
			message = {
				type: ColorPickerRenderMessageType.PutImageData,
				payload: color,
			};
			break;
		}
		case ColorPickerRenderMessageType.GetPreviewImageData: {
			const imageData = await handleGetPreviewImageData();
			message = {
				type: ColorPickerRenderMessageType.GetPreviewImageData,
				payload: {
					imageData,
				},
			};
			break;
		}
		case ColorPickerRenderMessageType.SwitchCaptureHistory:
			// handleSwitchCaptureHistory 内部 finally 已负责回传结果，避免双发
			await handleSwitchCaptureHistory(data);
			return true;
		case ColorPickerRenderMessageType.PickColor: {
			const pickColorResult = await handlePickColor(data);
			message = {
				type: ColorPickerRenderMessageType.PickColor,
				payload: pickColorResult,
			};
			break;
		}
	}

	self.postMessage(message);
	return false;
};

// 串行消息队列：确保前一条消息处理完成后再处理下一条
let processing = false;
const messageQueue: ColorPickerRenderData[] = [];

const flushQueue = async () => {
	if (processing) return;
	const next = messageQueue.shift();
	if (!next) return;
	processing = true;
	try {
		await processMessage(next);
	} catch (error) {
		console.error("[renderWorker] processMessage error", error);
	} finally {
		processing = false;
		if (messageQueue.length > 0) {
			flushQueue();
		}
	}
};

self.onmessage = ({ data }: MessageEvent<ColorPickerRenderData>) => {
	// 错误监听仅在首次 onmessage 时注册，避免模块顶层赋值被 rsbuild 重排触发 TDZ
	if (!(self as any).__listenersInited) {
		(self as any).__listenersInited = true;

		self.onerror = (event) => {
			console.error("[renderWorker] onerror", {
				message: (event as ErrorEvent)?.message,
				filename: (event as ErrorEvent)?.filename,
				lineno: (event as ErrorEvent)?.lineno,
				colno: (event as ErrorEvent)?.colno,
				error: (event as ErrorEvent)?.error,
			});
		};
		self.onunhandledrejection = (event) => {
			console.error(
				"[renderWorker] unhandledrejection",
				(event as PromiseRejectionEvent)?.reason,
			);
		};
	}

	messageQueue.push(data);
	flushQueue();
};

// 父 Worker 终止前，必须手动终止子 Worker
self.onabort = () => {
	terminateWebWorker(); // 终止在此 Worker 内部创建的子 Worker
};
