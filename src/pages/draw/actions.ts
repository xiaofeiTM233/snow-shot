import { basename } from "node:path";
import type { ExcalidrawElement } from "@mg-chao/excalidraw/element/types";
import type { Window as AppWindow } from "@tauri-apps/api/window";
import urlJoin from "url-join";
import { createDrawWindow, saveFile } from "@/commands";
import {
	writeBitmapImageToClipboard,
	writeBitmapImageToClipboardWithSharedBuffer,
	writeImagePixelsToClipboardWithSharedBuffer,
} from "@/commands/core";
import { uploadToS3 } from "@/commands/httpServices";
import { createWebViewSharedBufferChannel } from "@/commands/webview";
import type { ImageLayerActionType } from "@/components/imageLayer";
import { INIT_CONTAINER_KEY } from "@/components/imageLayer/actions";
import {
	type AppSettingsData,
	AppSettingsGroup,
	CloudSaveUrlFormat,
} from "@/types/appSettings";
import { ImageFormat, type ImagePath } from "@/types/utils/file";
import { writeImageToClipboard } from "@/utils/clipboard";
import { generateImageFileName, showImageDialog } from "@/utils/file";
import { appError } from "@/utils/log";
import { getPlatform } from "@/utils/platform";
import { randomString } from "@/utils/random";
import { getWebViewSharedBuffer } from "@/utils/webview";
import { setWindowRect } from "@/utils/window";
import type { FixedContentActionType } from "../fixedContent/components/fixedContentCore";
import type { AllOcrResult } from "../fixedContent/components/ocrResult";
import type { DrawLayerActionType } from "./components/drawLayer/extra";
import type { OcrBlocksActionType } from "./components/ocrBlocks";
import type {
	SelectLayerActionType,
	SelectRectParams,
} from "./components/selectLayer";
import type { CaptureBoundingBoxInfo } from "./extra";
import { CaptureStep } from "./types";

const getCanvasCore = async (
	selectRectParams: SelectRectParams | undefined,
	imageLayerAction: ImageLayerActionType,
	drawLayerAction: DrawLayerActionType,
	ignoreStyle?: boolean,
	ignoreDrawLayer?: boolean,
	renderContainerKey?: string,
): Promise<HTMLCanvasElement | ImageData | undefined> => {
	if (!selectRectParams) {
		return;
	}

	const { rect: selectRect, shadowColor: selectRectShadowColor } =
		selectRectParams;

	let selectRectShadowWidth = 0;
	let selectRectRadius = 0;
	if (!ignoreStyle) {
		selectRectShadowWidth = selectRectParams.shadowWidth;
		selectRectRadius = selectRectParams.radius;
	}

	drawLayerAction.finishDraw();
	const drawElements =
		drawLayerAction.getExcalidrawAPI()?.getSceneElements() ?? [];

	// 获取图像数据
	const imageLayerImageBitmap = await imageLayerAction.getImageBitmap(
		selectRect,
		renderContainerKey,
	);

	const drawLayerCanvas =
		!ignoreDrawLayer && drawElements.length > 0
			? drawLayerAction.getCanvas()
			: undefined;

	if (!imageLayerImageBitmap) {
		return;
	}

	const offsetX = selectRectShadowWidth;
	const offsetY = selectRectShadowWidth;

	const tempCanvas = document.createElement("canvas");
	const contentWidth = selectRect.max_x - selectRect.min_x;
	const contentHeight = selectRect.max_y - selectRect.min_y;

	tempCanvas.width = contentWidth + selectRectShadowWidth * 2;
	tempCanvas.height = contentHeight + selectRectShadowWidth * 2;
	const tempCtx = tempCanvas.getContext("2d");
	if (!tempCtx) {
		return;
	}

	tempCtx.drawImage(imageLayerImageBitmap, offsetX, offsetY);
	if (drawLayerCanvas) {
		tempCtx.drawImage(
			drawLayerCanvas,
			-selectRect.min_x + offsetX,
			-selectRect.min_y + offsetY,
		);
	}

	if (selectRectRadius > 0 || selectRectShadowWidth > 0) {
		tempCtx.save();

		tempCtx.beginPath();
		tempCtx.rect(0, 0, tempCanvas.width, tempCanvas.height);
		if (selectRectRadius > 0) {
			tempCtx.roundRect(
				offsetX,
				offsetY,
				contentWidth,
				contentHeight,
				selectRectRadius,
			);
		} else {
			tempCtx.rect(offsetX, offsetY, contentWidth, contentHeight);
		}
		tempCtx.clip("evenodd");
		tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);

		tempCtx.restore();
	}

	if (selectRectShadowWidth > 0) {
		tempCtx.beginPath();
		tempCtx.rect(0, 0, tempCanvas.width, tempCanvas.height);
		if (selectRectRadius > 0) {
			tempCtx.roundRect(
				offsetX,
				offsetY,
				contentWidth,
				contentHeight,
				selectRectRadius,
			);
		} else {
			tempCtx.rect(offsetX, offsetY, contentWidth, contentHeight);
		}
		tempCtx.clip("evenodd");

		tempCtx.shadowBlur = selectRectShadowWidth;
		tempCtx.shadowColor = selectRectShadowColor;
		tempCtx.fillStyle = selectRectShadowColor;

		tempCtx.beginPath();

		if (selectRectRadius > 0) {
			tempCtx.roundRect(
				offsetX,
				offsetY,
				contentWidth,
				contentHeight,
				selectRectRadius,
			);
		} else {
			tempCtx.rect(offsetX, offsetY, contentWidth, contentHeight);
		}

		tempCtx.fill();
	}

	return tempCanvas;
};

export const getCanvas = async (
	selectRectParams: SelectRectParams | undefined,
	imageLayerAction: ImageLayerActionType,
	drawLayerAction: DrawLayerActionType,
	ignoreStyle?: boolean,
	ignoreDrawLayer?: boolean,
	renderContainerKey?: string,
): Promise<HTMLCanvasElement | undefined> => {
	return getCanvasCore(
		selectRectParams,
		imageLayerAction,
		drawLayerAction,
		ignoreStyle,
		ignoreDrawLayer,
		renderContainerKey,
	) as Promise<HTMLCanvasElement | undefined>;
};

/**
 * 保存截图到指定文件
 */
export const saveToFile = async (
	appSettings: AppSettingsData,
	imageCanvas: HTMLCanvasElement | undefined,
	beforeSaveFile?: (filePath: string) => Promise<void>,
	prevImageFormat?: ImageFormat,
	fastSavePath?: ImagePath,
) => {
	const imagePath =
		fastSavePath ?? (await showImageDialog(appSettings, prevImageFormat));

	if (!imagePath) {
		return;
	}

	const imageDataPromise = new Promise<HTMLCanvasElement | undefined>(
		(resolve) => {
			resolve(imageCanvas);
		},
	)
		.then(async (canvas) => {
			if (!canvas) {
				return;
			}

			let blobType: string = imagePath.imageFormat;
			if (
				imagePath.imageFormat === ImageFormat.AVIF ||
				imagePath.imageFormat === ImageFormat.JPEG_XL
			) {
				blobType = "image/webp";
			}

			return new Promise<Blob | null>((resolve) => {
				canvas.toBlob(resolve, blobType, 1);
			});
		})
		.then((blob) => {
			if (!blob) {
				return;
			}

			if (blob instanceof Blob) {
				return blob.arrayBuffer();
			}

			return blob;
		});

	if (beforeSaveFile) {
		await beforeSaveFile(imagePath.filePath);
	}

	const imageData = await imageDataPromise;

	if (!imageData) {
		appError("[saveToFile] imageData is undefined");
		return;
	}

	await saveFile(imagePath.filePath, imageData, imagePath.imageFormat);
};

export const fixedToScreen = async (
	captureBoundingBoxInfo: CaptureBoundingBoxInfo,
	appWindow: AppWindow,
	layerContainerElement: HTMLDivElement,
	selectLayerAction: SelectLayerActionType,
	fixedContentAction: FixedContentActionType,
	imageLayerAction: ImageLayerActionType,
	drawLayerAction: DrawLayerActionType,
	setCaptureStep: (step: CaptureStep) => void,
	/** 已有的 OCR 结果 */
	allOcrResult: AllOcrResult | undefined,
	saveCaptureHistory: (canvas: HTMLCanvasElement) => Promise<void>,
	onFixedContentLoad: () => void,
	showFixedContent: () => void,
) => {
	// 创建一个固定的图片
	const selectRectParams = selectLayerAction.getSelectRectParams();
	const appState = drawLayerAction.getAppState();
	const elements = drawLayerAction.getExcalidrawAPI()?.getSceneElements() ?? [];
	const windowDevicePixelRatio = window.devicePixelRatio;
	if (!selectRectParams) {
		return;
	}

	layerContainerElement.style.opacity = "0";
	layerContainerElement.style.pointerEvents = "none";

	const canvasPromise = getCanvas(
		selectRectParams,
		imageLayerAction,
		drawLayerAction,
		undefined,
		true,
		INIT_CONTAINER_KEY,
	);

	const initPreloadPromise = fixedContentAction.initDrawPreload(
		selectRectParams.rect.max_x -
			selectRectParams.rect.min_x +
			selectRectParams.shadowWidth * 2,
		selectRectParams.rect.max_y -
			selectRectParams.rect.min_y +
			selectRectParams.shadowWidth * 2,
	);

	setCaptureStep(CaptureStep.Fixed);
	createDrawWindow();
	showFixedContent();

	const [canvas] = await Promise.all([
		canvasPromise.then((canvas) => {
			if (!canvas) {
				return;
			}

			saveCaptureHistory(canvas).then(() => {
				onFixedContentLoad();
			});
			return canvas;
		}),
		appWindow.setTitle("Snow Shot - Fixed Content"),
		new Promise((resolve) => {
			setTimeout(() => {
				if (getPlatform() === "windows") {
					resolve(true);
				} else {
					// macOS 延迟一会，避免过渡异常
					setTimeout(() => {
						setTimeout(() => {
							resolve(true);
						}, 17);
					}, 0);
				}
			}, 17 * 2);
		}).then(() => {
			return setWindowRect(
				appWindow,
				captureBoundingBoxInfo.transformWindowRect({
					min_x: selectRectParams.rect.min_x - selectRectParams.shadowWidth,
					min_y: selectRectParams.rect.min_y - selectRectParams.shadowWidth,
					max_x: selectRectParams.rect.max_x + selectRectParams.shadowWidth,
					max_y: selectRectParams.rect.max_y + selectRectParams.shadowWidth,
				}),
			);
		}),
		appWindow.setAlwaysOnTop(true),
	]);

	if (!canvas) {
		appError("[fixedToScreen] canvas is undefined");
		return;
	}

	await Promise.all([
		await initPreloadPromise.then(() => {
			return fixedContentAction.init({
				canvas,
				captureBoundingBoxInfo,
				drawElements: {
					scrollX: appState?.scrollX ?? 0,
					scrollY: appState?.scrollY ?? 0,
					zoom: appState?.zoom?.value ?? 1,
					elements: elements as ExcalidrawElement[],
				},
				allOcrResult,
				selectRectParams,
				windowDevicePixelRatio,
			});
		}),
	]);
};

const copyBitmapImageToClipboardWithSharedBuffer = async (
	imageCanvas: HTMLCanvasElement,
	type: "bitmap" | "image",
): Promise<boolean> => {
	const sharedBufferChannelId = `copyToClipboard:${Date.now()}:${randomString(8)}`;
	const getWebViewSharedBufferPromise = getWebViewSharedBuffer(
		sharedBufferChannelId,
	);

	const createResult = await createWebViewSharedBufferChannel(
		sharedBufferChannelId,
		imageCanvas.width * imageCanvas.height * 4 + 8, // 后 8 个字节写入宽高
	);
	if (!createResult) {
		return false;
	}

	const imageDataArray = imageCanvas
		.getContext("2d")
		?.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
	if (!imageDataArray) {
		appError(
			"[copyBitmapImageToClipboardWithSharedBuffer] imageDataArray is undefined",
		);
		return false;
	}

	const reciveData = (await getWebViewSharedBufferPromise) as unknown as
		| SharedArrayBuffer
		| undefined;
	if (!reciveData) {
		appError(
			"[copyBitmapImageToClipboardWithSharedBuffer] reciveData is undefined",
		);
		return false;
	}

	// 将 ImageData 写入 SharedArrayBuffer
	const sharedArray = new Uint8ClampedArray(reciveData);
	sharedArray.set(imageDataArray.data);

	// 将宽高以 u32 字节形式写入最后 8 个字节（使用 Uint32Array 更高效）
	const u32Array = new Uint32Array(reciveData, imageDataArray.data.length, 2);
	u32Array[0] = imageCanvas.width;
	u32Array[1] = imageCanvas.height;

	if (type === "bitmap") {
		await writeBitmapImageToClipboardWithSharedBuffer(sharedBufferChannelId);
	} else {
		await writeImagePixelsToClipboardWithSharedBuffer(sharedBufferChannelId);
	}

	return true;
};

const convertImageDataToArrayBuffer = async (
	imageData: Blob | ArrayBuffer | HTMLCanvasElement,
): Promise<ArrayBuffer | undefined> => {
	let imageDataArrayBuffer: ArrayBuffer | undefined;
	if (imageData instanceof Blob) {
		imageDataArrayBuffer = await imageData.arrayBuffer();
	} else if (imageData instanceof ArrayBuffer) {
		imageDataArrayBuffer = imageData;
	} else if (imageData instanceof HTMLCanvasElement) {
		const blobArrayBuffer = await new Promise<ArrayBuffer | undefined>(
			(resolve) => {
				imageData.toBlob(
					async (blob) => {
						if (!blob) {
							resolve(undefined);
							return;
						}

						resolve(await blob.arrayBuffer());
					},
					"image/png",
					1,
				);
			},
		);

		if (!blobArrayBuffer) {
			appError("[copyToClipboard] blobArrayBuffer is undefined");
			return;
		}

		imageDataArrayBuffer = blobArrayBuffer;
	}

	return imageDataArrayBuffer;
};

export const copyToClipboard = async (
	imageData: Blob | ArrayBuffer | HTMLCanvasElement,
	appSettings: AppSettingsData | undefined,
	selectRectParams: SelectRectParams | undefined,
) => {
	let imageDataArrayBuffer: ArrayBuffer | undefined;
	// 已编码好的图像（ArrayBuffer/Blob，如截图历史、全屏截图）没有 selectRectParams，
	// 不应被圆角/阴影样式限制挡在 DIB 复制之外；只要开启 tryWriteBitmapImageToClipboard 就走 DIB。
	// 带圆角/阴影的 HTMLCanvasElement（区域截图）仍按原 selectRectParams 样式判断。
	const isEncodedImage =
		imageData instanceof ArrayBuffer || imageData instanceof Blob;
	const useDib =
		getPlatform() === "windows" &&
		appSettings?.[AppSettingsGroup.SystemScreenshot]
			.tryWriteBitmapImageToClipboard &&
		(isEncodedImage ||
			(selectRectParams !== undefined &&
				selectRectParams.shadowWidth === 0 &&
				selectRectParams.radius === 0));
	if (useDib) {
		try {
			if (imageData instanceof HTMLCanvasElement) {
				if (
					await copyBitmapImageToClipboardWithSharedBuffer(imageData, "bitmap")
				) {
					return;
				}
			}

			imageDataArrayBuffer = await convertImageDataToArrayBuffer(imageData);
			if (!imageDataArrayBuffer) {
				appError(
					"[copyToClipboard] imageDataArrayBuffer is undefined(writeBitmapImageToClipboard)",
				);
				return;
			}

			await writeBitmapImageToClipboard(imageDataArrayBuffer);

			return;
		} catch (error) {
			appError("[copyToClipboard] writeBitmapImageToClipboard error", error);
		}
	} else {
		if (imageData instanceof HTMLCanvasElement) {
			if (
				await copyBitmapImageToClipboardWithSharedBuffer(imageData, "image")
			) {
				return;
			}
		}
	}

	if (!imageDataArrayBuffer) {
		imageDataArrayBuffer = await convertImageDataToArrayBuffer(imageData);
	}

	if (!imageDataArrayBuffer) {
		appError(
			"[copyToClipboard] imageDataArrayBuffer is undefined(writeImageToClipboard)",
		);
		return;
	}

	await writeImageToClipboard(imageDataArrayBuffer);
};

export const handleOcrDetect = async (
	captureBoundingBoxInfo: CaptureBoundingBoxInfo,
	selectLayerAction: SelectLayerActionType,
	imageLayerAction: ImageLayerActionType,
	drawLayerAction: DrawLayerActionType,
	ocrBlocksAction: OcrBlocksActionType,
	/** 忽略如圆角、阴影等样式 */
	ignoreStyle?: boolean,
) => {
	const selectRectParams = selectLayerAction.getSelectRectParams();
	if (!selectRectParams) {
		return;
	}

	const { rect: selectRect } = selectRectParams;

	if (!selectRect) {
		return;
	}

	const imageCanvas = await getCanvas(
		selectRectParams,
		imageLayerAction,
		drawLayerAction,
		ignoreStyle,
		true,
		INIT_CONTAINER_KEY,
	);
	if (!imageCanvas) {
		return;
	}

	await ocrBlocksAction.init(
		selectRect,
		captureBoundingBoxInfo,
		imageCanvas,
		undefined,
	);
};

export const saveCanvasToCloud = async (
	imageData: ArrayBuffer | HTMLCanvasElement,
	appSettings: AppSettingsData,
): Promise<
	| string
	| {
			error: unknown;
	  }
> => {
	let imageBuffer: ArrayBuffer | undefined;
	if (imageData instanceof HTMLCanvasElement) {
		imageBuffer = await new Promise<ArrayBuffer | undefined>((resolve) => {
			imageData?.toBlob(
				async (blob) => {
					resolve(await blob?.arrayBuffer());
				},
				"image/png",
				1,
			);
		});
	} else if (imageData instanceof ArrayBuffer) {
		imageBuffer = imageData;
	}

	if (!imageBuffer) {
		return {
			error: new Error("imageBuffer is undefined"),
		};
	}

	try {
		const fileName = `${generateImageFileName(
			appSettings[AppSettingsGroup.FunctionOutput].uploadToCloudSaveUrlFormat,
		)}.png`;
		let result = await uploadToS3(
			appSettings[AppSettingsGroup.FunctionScreenshot].s3Endpoint,
			appSettings[AppSettingsGroup.FunctionScreenshot].s3Region,
			appSettings[AppSettingsGroup.FunctionScreenshot].s3AccessKeyId,
			appSettings[AppSettingsGroup.FunctionScreenshot].s3SecretAccessKey,
			appSettings[AppSettingsGroup.FunctionScreenshot].s3BucketName,
			appSettings[AppSettingsGroup.FunctionScreenshot].s3PathPrefix,
			appSettings[AppSettingsGroup.FunctionScreenshot].s3ForcePathStyle,
			imageBuffer,
			fileName,
			"image/png",
		);

		const cloudProxyUrl =
			appSettings[AppSettingsGroup.FunctionScreenshot].cloudProxyUrl;
		if (cloudProxyUrl) {
			const resultUrl = urlJoin(cloudProxyUrl, fileName);
			result = resultUrl.toString();
		}

		if (
			appSettings[AppSettingsGroup.FunctionScreenshot].cloudSaveUrlFormat ===
			CloudSaveUrlFormat.Markdown
		) {
			result = `![${basename(result, ".png")}](${result})`;
		}

		return result;
	} catch (error) {
		return {
			error,
		};
	}
};
