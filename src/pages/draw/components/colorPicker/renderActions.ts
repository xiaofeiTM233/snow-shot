import type { RefType } from "@/components/imageLayer/baseLayerRenderActions";
import type { ImageSharedBufferData } from "../../tools";
import { getPixels, terminateWebWorker } from "./workers/getPixels";

export const COLOR_PICKER_PREVIEW_SCALE = 12;
export const COLOR_PICKER_PREVIEW_PICKER_SIZE = 10 + 1;
export const COLOR_PICKER_PREVIEW_CANVAS_SIZE =
	COLOR_PICKER_PREVIEW_PICKER_SIZE * COLOR_PICKER_PREVIEW_SCALE;

export const renderInitPreviewCanvasAction = (
	previewCanvasRef: RefType<HTMLCanvasElement | OffscreenCanvas | null>,
	previewCanvas: HTMLCanvasElement | OffscreenCanvas,
	previewCanvasCtxRef: RefType<
		OffscreenCanvasRenderingContext2D | RenderingContext | null
	>,
) => {
	previewCanvasRef.current = previewCanvas;

	const ctx = previewCanvas.getContext("2d");
	if (!ctx) {
		return;
	}

	previewCanvasCtxRef.current = ctx;
	previewCanvas.width = COLOR_PICKER_PREVIEW_PICKER_SIZE;
	previewCanvas.height = COLOR_PICKER_PREVIEW_PICKER_SIZE;
};

export function renderInitImageDataAction(
	_previewCanvasRef: RefType<OffscreenCanvas | HTMLCanvasElement | null>,
	previewImageDataRef: RefType<ImageData | null>,
	imageSrc: ArrayBuffer | ImageSharedBufferData,
): Promise<void> {
	return new Promise((resolve) => {
		if ("sharedBuffer" in imageSrc) {
			previewImageDataRef.current = new ImageData(
				imageSrc.sharedBuffer,
				imageSrc.width,
				imageSrc.height,
			);

			resolve(undefined);
			return;
		}

		getPixels(imageSrc as ArrayBuffer)
			.then((pixels) => {
				previewImageDataRef.current = pixels.data;

				resolve(undefined);
			})
			.catch((error) => {
				previewImageDataRef.current = null;
				console.warn("renderInitImageDataAction decode failed", { error });
				resolve(undefined);
			});
	});
}

export function renderPutImageDataAction(
	previewCanvasCtxRef: RefType<
		OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
	>,
	previewImageDataRef: RefType<ImageData | null>,
	captureHistoryImageDataRef: RefType<ImageData | undefined>,
	x: number,
	y: number,
	colorX: number,
	colorY: number,
	centerAuxiliaryLineColor: string | undefined,
): { color: [red: number, green: number, blue: number] } {
	const ctx = previewCanvasCtxRef.current;
	const useHistory = !!captureHistoryImageDataRef.current;
	const imageData =
		captureHistoryImageDataRef.current ?? previewImageDataRef.current;
	console.log("[CP-DIAG] renderPutImageDataAction", {
		useHistory,
		historyW: captureHistoryImageDataRef.current?.width,
		historyH: captureHistoryImageDataRef.current?.height,
		previewW: previewImageDataRef.current?.width,
		previewH: previewImageDataRef.current?.height,
		x,
		y,
		colorX,
		colorY,
	});
	if (!ctx || !imageData) {
		return {
			color: [0, 0, 0],
		};
	}

	ctx.clearRect(
		0,
		0,
		COLOR_PICKER_PREVIEW_PICKER_SIZE,
		COLOR_PICKER_PREVIEW_PICKER_SIZE,
	);

	ctx.putImageData(
		imageData,
		-x,
		-y,
		x,
		y,
		COLOR_PICKER_PREVIEW_PICKER_SIZE,
		COLOR_PICKER_PREVIEW_PICKER_SIZE,
	);

	if (centerAuxiliaryLineColor) {
		const centerX = Math.floor(COLOR_PICKER_PREVIEW_PICKER_SIZE / 2) + 0.5;
		const centerY = Math.floor(COLOR_PICKER_PREVIEW_PICKER_SIZE / 2) + 0.5;

		ctx.save();
		ctx.strokeStyle = centerAuxiliaryLineColor;
		ctx.lineWidth = 1;

		// 绘制4条线，避免中心点被覆盖
		// 左半部分垂直线
		ctx.beginPath();
		ctx.moveTo(centerX, 0);
		ctx.lineTo(centerX, centerY - 0.5);
		ctx.stroke();

		// 右半部分垂直线
		ctx.beginPath();
		ctx.moveTo(centerX, centerY + 0.5);
		ctx.lineTo(centerX, COLOR_PICKER_PREVIEW_PICKER_SIZE);
		ctx.stroke();

		// 上半部分水平线
		ctx.beginPath();
		ctx.moveTo(0, centerY);
		ctx.lineTo(centerX - 0.5, centerY);
		ctx.stroke();

		// 下半部分水平线
		ctx.beginPath();
		ctx.moveTo(centerX + 0.5, centerY);
		ctx.lineTo(COLOR_PICKER_PREVIEW_PICKER_SIZE, centerY);
		ctx.stroke();

		ctx.restore();
	}

	const baseIndex = (colorY * imageData.width + colorX) * 4;
	const color: [red: number, green: number, blue: number] = [
		imageData.data[baseIndex] ?? 0,
		imageData.data[baseIndex + 1] ?? 0,
		imageData.data[baseIndex + 2] ?? 0,
	];

	return {
		color,
	};
}

export function renderGetPreviewImageDataAction(
	previewImageDataRef: RefType<ImageData | null>,
	captureHistoryImageDataRef: RefType<ImageData | undefined>,
): ImageData | null {
	if (captureHistoryImageDataRef.current) {
		return captureHistoryImageDataRef.current;
	}
	return previewImageDataRef.current;
}

export async function renderSwitchCaptureHistoryAction(
	captureHistoryImageDataRef: RefType<ImageData | undefined>,
	imageSrc: string | undefined,
): Promise<void> {
	if (!imageSrc) {
		captureHistoryImageDataRef.current = undefined;
		console.log("[CP-DIAG] renderSwitchCaptureHistoryAction: cleared (no imageSrc)");
		return;
	}

	try {
		const fileBuffer = await fetch(imageSrc).then((res) => res.arrayBuffer());
		console.log("[CP-DIAG] renderSwitchCaptureHistoryAction: fetched", {
			imageSrc,
			byteLength: fileBuffer.byteLength,
		});
		const pixels = await getPixels(fileBuffer);
		captureHistoryImageDataRef.current = pixels.data;
		console.log("[CP-DIAG] renderSwitchCaptureHistoryAction: decoded", {
			width: pixels.width,
			height: pixels.height,
			dataLen: pixels.data.data.length,
		});
	} catch (error) {
		// 解码失败时保留上一张有效数据
		console.warn("[CP-DIAG] renderSwitchCaptureHistoryAction decode failed", {
			imageSrc,
			error,
		});
	}
}

export function renderPixelsWorkerTerminateAction() {
	terminateWebWorker();
}

export function renderPickColorAction(
	captureHistoryImageDataRef: RefType<ImageData | undefined>,
	previewImageDataRef: RefType<ImageData | null>,
	x: number,
	y: number,
): {
	color: [red: number, green: number, blue: number];
} {
	const imageData =
		captureHistoryImageDataRef.current ?? previewImageDataRef.current;
	if (!imageData) {
		return {
			color: [0, 0, 0],
		};
	}

	const baseIndex = (y * imageData.width + x) * 4;
	const color: [red: number, green: number, blue: number] = [
		imageData.data[baseIndex] ?? 0,
		imageData.data[baseIndex + 1] ?? 0,
		imageData.data[baseIndex + 2] ?? 0,
	];

	return {
		color,
	};
}
