import type { RefType } from "@/components/imageLayer/baseLayerRenderActions";
import type { ImageBuffer } from "@/types/commands/screenshot";
import { appWarn } from "@/utils/log";
import type { ImageSharedBufferData } from "../../tools";
import {
	renderGetPreviewImageDataAction,
	renderInitImageDataAction,
	renderInitPreviewCanvasAction,
	renderPickColorAction,
	renderPixelsWorkerTerminateAction,
	renderPutImageDataAction,
	renderSwitchCaptureHistoryAction,
} from "./renderActions";
import {
	type ColorPickerRenderGetPreviewImageDataData,
	type ColorPickerRenderGetPreviewImageDataResult,
	type ColorPickerRenderInitImageDataData,
	type ColorPickerRenderInitImageDataResult,
	type ColorPickerRenderInitPreviewCanvasData,
	type ColorPickerRenderInitPreviewCanvasResult,
	ColorPickerRenderMessageType,
	type ColorPickerRenderPickColorData,
	type ColorPickerRenderPickColorResult,
	type ColorPickerRenderPutImageDataData,
	type ColorPickerRenderPutImageDataResult,
	type ColorPickerRenderSwitchCaptureHistoryData,
	type ColorPickerRenderSwitchCaptureHistoryResult,
} from "./workers/renderWorkerTypes";

export const initPreviewCanvasAction = async (
	renderWorker: Worker | undefined,
	previewCanvasRef: RefType<OffscreenCanvas | HTMLCanvasElement | null>,
	previewCanvas: HTMLCanvasElement | OffscreenCanvas,
	previewOffscreenCanvasRef: RefType<OffscreenCanvas | null>,
	previewCanvasCtxRef: RefType<
		OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
	>,
	transfer: Transferable[] | undefined,
) => {
	return new Promise((resolve) => {
		if (renderWorker) {
			if (!previewOffscreenCanvasRef.current) {
				appWarn(
					"[initPreviewCanvasAction] previewOffscreenCanvasRef.current is null",
				);
				resolve(undefined);
				return;
			}
			const InitPreviewCanvasData: ColorPickerRenderInitPreviewCanvasData = {
				type: ColorPickerRenderMessageType.InitPreviewCanvas,
				payload: {
					previewCanvas: previewOffscreenCanvasRef.current,
				},
			};

			const handleMessage = (
				event: MessageEvent<ColorPickerRenderInitPreviewCanvasResult>,
			) => {
				const { type, payload } = event.data;
				if (type === ColorPickerRenderMessageType.InitPreviewCanvas) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			if (transfer) {
				renderWorker.postMessage(InitPreviewCanvasData, transfer);
			} else {
				renderWorker.postMessage(InitPreviewCanvasData);
			}
		} else {
			renderInitPreviewCanvasAction(
				previewCanvasRef,
				previewCanvas,
				previewCanvasCtxRef,
			);
			resolve(undefined);
		}
	});
};

export const initImageDataAction = async (
	renderWorker: Worker | undefined,
	previewCanvasRef: RefType<OffscreenCanvas | HTMLCanvasElement | null>,
	previewImageDataRef: RefType<ImageData | null>,
	imageBuffer: ImageBuffer | ImageSharedBufferData,
) => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const InitImageDataData: ColorPickerRenderInitImageDataData = {
				type: ColorPickerRenderMessageType.InitImageData,
				payload: {
					imageBuffer:
						"sharedBuffer" in imageBuffer ? imageBuffer : imageBuffer.buffer,
				},
			};

			const handleMessage = (
				event: MessageEvent<ColorPickerRenderInitImageDataResult>,
			) => {
				const { type, payload } = event.data;
				if (type === ColorPickerRenderMessageType.InitImageData) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			if ("sharedBuffer" in imageBuffer && imageBuffer.sharedBuffer.buffer) {
				renderWorker.postMessage(InitImageDataData, {
					transfer: [imageBuffer.sharedBuffer.buffer],
				});
			} else {
				renderWorker.postMessage(InitImageDataData);
			}
		} else {
			renderInitImageDataAction(
				previewCanvasRef,
				previewImageDataRef,
				"sharedBuffer" in imageBuffer ? imageBuffer : imageBuffer.buffer,
			).then(() => {
				resolve(undefined);
			});
		}
	});
};

export const putImageDataAction = async (
	renderWorker: Worker | undefined,
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
): Promise<{ color: [red: number, green: number, blue: number] }> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const PutImageDataData: ColorPickerRenderPutImageDataData = {
				type: ColorPickerRenderMessageType.PutImageData,
				payload: {
					x,
					y,
					colorX,
					colorY,
					centerAuxiliaryLineColor,
				},
			};

			const handleMessage = (
				event: MessageEvent<ColorPickerRenderPutImageDataResult>,
			) => {
				const { type, payload } = event.data;
				if (type === ColorPickerRenderMessageType.PutImageData) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(PutImageDataData);
		} else {
			const color = renderPutImageDataAction(
				previewCanvasCtxRef,
				previewImageDataRef,
				captureHistoryImageDataRef,
				x,
				y,
				colorX,
				colorY,
				centerAuxiliaryLineColor,
			);
			resolve(color);
		}
	});
};

export const getPreviewImageDataAction = async (
	renderWorker: Worker | undefined,
	previewImageDataRef: RefType<ImageData | null>,
	captureHistoryImageDataRef: RefType<ImageData | undefined>,
): Promise<ImageData | null> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const GetPreviewImageDataData: ColorPickerRenderGetPreviewImageDataData =
				{
					type: ColorPickerRenderMessageType.GetPreviewImageData,
					payload: undefined,
				};

			const handleMessage = (
				event: MessageEvent<ColorPickerRenderGetPreviewImageDataResult>,
			) => {
				const { type, payload } = event.data;
				if (type === ColorPickerRenderMessageType.GetPreviewImageData) {
					resolve(payload.imageData);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(GetPreviewImageDataData);
		} else {
			const imageData = renderGetPreviewImageDataAction(
				previewImageDataRef,
				captureHistoryImageDataRef,
			);
			resolve(imageData);
		}
	});
};

export const switchCaptureHistoryAction = async (
	renderWorker: Worker | undefined,
	captureHistoryImageDataRef: RefType<ImageData | undefined>,
	imageSrc: string | undefined,
): Promise<void> => {
	// 主线程先 fetch 历史截图（worker 中 fetch asset URL 会挂起），
	// 再把 ArrayBuffer transfer 给 worker 解码
	let imageBuffer: ArrayBuffer | undefined;
	if (imageSrc) {
		try {
			imageBuffer = await fetch(imageSrc).then((res) => res.arrayBuffer());
			console.log("[CP-DIAG] mainthread fetch ok", {
				imageSrc,
				byteLength: imageBuffer.byteLength,
			});
		} catch (error) {
			console.warn("[CP-DIAG] mainthread fetch FAILED", {
				imageSrc,
				error,
			});
		}
	}

	return new Promise((resolve) => {
		// 兜底：worker 彻底无响应时避免 Promise 永久 pending
		const timer = setTimeout(() => {
			renderWorker?.removeEventListener("message", handleMessage);
			console.warn("[CP-DIAG] switchCaptureHistoryAction: TIMER TIMEOUT (1000ms)");
			resolve(undefined);
		}, 1000);

		const handleMessage = (
			event: MessageEvent<ColorPickerRenderSwitchCaptureHistoryResult>,
		) => {
			const { type, payload } = event.data;
			if (type === ColorPickerRenderMessageType.SwitchCaptureHistory) {
				console.log("[CP-DIAG] switchCaptureHistoryAction: worker replied");
				clearTimeout(timer);
				resolve(payload);
				renderWorker?.removeEventListener("message", handleMessage);
			}
		};

		if (renderWorker) {
			const SwitchCaptureHistoryData: ColorPickerRenderSwitchCaptureHistoryData =
				{
					type: ColorPickerRenderMessageType.SwitchCaptureHistory,
					payload: {
						imageSrc,
						imageBuffer,
					},
				};

			renderWorker.addEventListener("message", handleMessage);

			console.log("[CP-DIAG] posting SwitchCaptureHistory to worker", {
				hasBuffer: !!imageBuffer,
				bufferByteLength: imageBuffer?.byteLength,
			});

			// transfer ArrayBuffer 所有权，避免拷贝大图
			if (imageBuffer) {
				renderWorker.postMessage(SwitchCaptureHistoryData, [imageBuffer]);
			} else {
				renderWorker.postMessage(SwitchCaptureHistoryData);
			}
		} else {
			renderSwitchCaptureHistoryAction(
				captureHistoryImageDataRef,
				imageSrc,
				imageBuffer,
			)
				.then(() => {
					clearTimeout(timer);
					resolve(undefined);
				})
				.catch(() => {
					clearTimeout(timer);
					resolve(undefined);
				});
		}
	});
};

export const pickColorAction = async (
	renderWorker: Worker | undefined,
	captureHistoryImageDataRef: RefType<ImageData | undefined>,
	previewImageDataRef: RefType<ImageData | null>,
	x: number,
	y: number,
): Promise<{ color: [red: number, green: number, blue: number] }> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const PickColorData: ColorPickerRenderPickColorData = {
				type: ColorPickerRenderMessageType.PickColor,
				payload: {
					x,
					y,
				},
			};

			const handleMessage = (
				event: MessageEvent<ColorPickerRenderPickColorResult>,
			) => {
				const { type, payload } = event.data;
				if (type === ColorPickerRenderMessageType.PickColor) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(PickColorData);
		} else {
			const color = renderPickColorAction(
				captureHistoryImageDataRef,
				previewImageDataRef,
				x,
				y,
			);
			resolve(color);
		}
	});
};

export const terminateWorkerAction = async () => {
	renderPixelsWorkerTerminateAction();
};
