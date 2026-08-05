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

// 顶层全局错误监听：renderWorker 内任何未捕获崩溃（含子 Worker 抛出的
// 错误冒泡、async onmessage 内的 throw）默认只进 Worker 线程 Console，
// 主线程看不到。统一打出以便定位。
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

const previewCanvasRef: RefType<OffscreenCanvas | null> = {
	current: null,
};
const previewCanvasCtxRef: RefType<OffscreenCanvasRenderingContext2D | null> = {
	current: null,
};
const previewImageDataRef: RefType<ImageData | null> = {
	current: null,
};
const decoderWasmModuleArrayBufferRef: RefType<ArrayBuffer | null> = {
	current: null,
};
const captureHistoryImageDataRef: RefType<ImageData | undefined> = {
	current: undefined,
};

const handleInitPreviewCanvas = async (
	data: ColorPickerRenderInitPreviewCanvasData,
) => {
	const { previewCanvas, decoderWasmModuleArrayBuffer } = data.payload;

	renderInitPreviewCanvasAction(
		previewCanvasRef,
		previewCanvas,
		previewCanvasCtxRef,
		decoderWasmModuleArrayBufferRef,
		decoderWasmModuleArrayBuffer,
	);
};

const handleInitImageData = async (
	data: ColorPickerRenderInitImageDataData,
) => {
	const { imageBuffer } = data.payload;
	await renderInitImageDataAction(
		previewCanvasRef,
		previewImageDataRef,
		decoderWasmModuleArrayBufferRef,
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
			decoderWasmModuleArrayBufferRef,
			captureHistoryImageDataRef,
			imageSrc,
		);
	} catch (error) {
		// 历史截图解码失败时（如文件损坏/特殊编码），worker 不应崩溃
		// 保留上一张有效的 captureHistoryImageDataRef，避免污染取色数据
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

self.onmessage = async ({ data }: MessageEvent<ColorPickerRenderData>) => {
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
			return;
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
};

// 父 Worker 终止前，必须手动终止子 Worker
self.onabort = () => {
	terminateWebWorker(); // 终止在此 Worker 内部创建的子 Worker
};
