import type { RefType } from "@/components/imageLayer/baseLayerRenderActions";
import type { ImageSharedBufferData } from "../../tools";
import { terminateWebWorker } from "./workers/getPixels";

export const COLOR_PICKER_PREVIEW_SCALE = 12;
export const COLOR_PICKER_PREVIEW_PICKER_SIZE = 10 + 1;
export const COLOR_PICKER_PREVIEW_CANVAS_SIZE =
	COLOR_PICKER_PREVIEW_PICKER_SIZE * COLOR_PICKER_PREVIEW_SCALE;

/**
 * 用浏览器原生 createImageBitmap + OffscreenCanvas 解码图像 buffer 为 ImageData。
 * 直接在当前上下文（worker 或主线程）执行，不通过子 worker。
 */
async function decodeBufferToImageData(
	imageBuffer: ArrayBuffer,
): Promise<ImageData> {
	const blob = new Blob([imageBuffer], { type: "image/png" });
	const bitmap = await createImageBitmap(blob);
	const width = bitmap.width;
	const height = bitmap.height;

	const offscreen = new OffscreenCanvas(width, height);
	const ctx = offscreen.getContext("2d", { willReadFrequently: true });
	if (!ctx) {
		bitmap.close();
		throw new Error("decodeBufferToImageData: failed to get 2d context");
	}

	ctx.drawImage(bitmap, 0, 0);
	bitmap.close();

	return ctx.getImageData(0, 0, width, height);
}

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

		decodeBufferToImageData(imageSrc as ArrayBuffer)
			.then((imageData) => {
				previewImageDataRef.current = imageData;

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
	const imageData =
		captureHistoryImageDataRef.current ?? previewImageDataRef.current;
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
	imageBuffer: ArrayBuffer | undefined,
): Promise<void> {
	if (!imageSrc && !imageBuffer) {
		captureHistoryImageDataRef.current = undefined;
		return;
	}

	try {
		// 优先使用主线程已 fetch 好的 buffer（worker 中 fetch asset URL 会挂起），
		// 仅在无 buffer（非 worker 分支）时才自行 fetch
		const fileBuffer: ArrayBuffer =
			imageBuffer ??
			(await fetch(imageSrc!).then((res) => res.arrayBuffer()));

		// 直接在当前 worker（或主线程）内用 createImageBitmap 解码，
		// 不再通过 getPixels 子 worker（子 worker 在某些环境加载即崩溃）
		const imageData = await decodeBufferToImageData(fileBuffer);
		captureHistoryImageDataRef.current = imageData;
	} catch (error) {
		// 解码失败时保留上一张有效数据
		console.warn("renderSwitchCaptureHistoryAction decode failed", {
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
