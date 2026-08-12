import { invoke } from "@tauri-apps/api/core";
import type { HdrColorAlgorithm, CaptureMethod } from "@/types/appSettings";
import { appError, formatErrorDetails } from "@/utils/log";

export enum ScrollDirection {
	/// 垂直滚动
	Vertical = "Vertical",
	/// 水平滚动
	Horizontal = "Horizontal",
}

export enum ScrollImageList {
	/// 上图片列表
	Top = "Top",
	/// 下图片列表
	Bottom = "Bottom",
}

export const scrollScreenshotInit = async (
	direction: ScrollDirection,
	imageWidth: number,
	imageHeight: number,
	sampleRate: number,
	minSampleSize: number,
	maxSampleSize: number,
	cornerThreshold: number,
	descriptorPatchSize: number,
	minSizeDelta: number,
	tryRollback: boolean,
) => {
	const result = await invoke("scroll_screenshot_init", {
		direction,
		imageWidth,
		imageHeight,
		sampleRate,
		minSampleSize,
		maxSampleSize,
		cornerThreshold,
		descriptorPatchSize,
		minSizeDelta,
		tryRollback,
	});
	return result;
};

export type ScrollScreenshotCaptureResult = {
	type: "no_data" | "no_change" | "success" | "no_image";
	thumbnail_buffer: ArrayBuffer | undefined;
	edge_position: number | undefined;
	overlay_size: number | undefined;
	top_image_size?: number | undefined;
	bottom_image_size?: number | undefined;
	current_direction?: ScrollImageList | undefined;
};

export const SCROLL_SCREENSHOT_CAPTURE_RESULT_EXTRA_DATA_SIZE =
	4 + 4 + 4 + 4 + 4;

export const scrollScreenshotCapture = async (
	scrollImageList: ScrollImageList,
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
	correctHdrColorAlgorithm: HdrColorAlgorithm,
	correctColorFilter: boolean,
	captureMethod: CaptureMethod,
) => {
	const result = await invoke<ArrayBuffer>("scroll_screenshot_capture", {
		scrollImageList,
		minX,
		minY,
		maxX,
		maxY,
		correctHdrColorAlgorithm,
		correctColorFilter,
		captureMethod,
	});

	return result;
};

/**
 * @returns JPG 的 buffer 数据
 */
export const scrollScreenshotHandleImage = async (
	thumbnailSize: number,
): Promise<ScrollScreenshotCaptureResult> => {
	let result: ArrayBuffer | undefined;
	try {
		result = await invoke<ArrayBuffer>("scroll_screenshot_handle_image", {
			thumbnailSize,
		});
	} catch (error) {
		appError("[scrollScreenshotHandleImage] error", error);
		result = new ArrayBuffer();
	}

	if (result.byteLength === 0) {
		return {
			type: "no_data",
			thumbnail_buffer: result,
			edge_position: undefined,
			overlay_size: undefined,
		};
	}

	if (result.byteLength === 1) {
		const array = new Uint8Array(result);
		if (array[0] === 1) {
			return {
				type: "no_change",
				thumbnail_buffer: undefined,
				edge_position: 0,
				overlay_size: undefined,
			};
		} else if (array[0] === 2) {
			return {
				type: "no_image",
				thumbnail_buffer: undefined,
				edge_position: 0,
				overlay_size: undefined,
			};
		} else {
			return {
				type: "no_data",
				thumbnail_buffer: new ArrayBuffer(),
				edge_position: undefined,
				overlay_size: undefined,
			};
		}
	}

	// 将屏幕信息和图像数据分离
	const imageDataLength =
		result.byteLength - SCROLL_SCREENSHOT_CAPTURE_RESULT_EXTRA_DATA_SIZE;

	// 提取屏幕信息
	const screenInfoView = new DataView(
		result,
		imageDataLength,
		SCROLL_SCREENSHOT_CAPTURE_RESULT_EXTRA_DATA_SIZE,
	);
	const edgePosition = screenInfoView.getInt32(0, true); // i32
	const overlaySize = screenInfoView.getInt32(4, true); // i32
	const topImageSize = screenInfoView.getInt32(8, true); // i32
	const bottomImageSize = screenInfoView.getInt32(12, true); // i32
	const currentDirection =
		screenInfoView.getInt32(16, true) === 0
			? ScrollImageList.Top
			: ScrollImageList.Bottom; // i32

	return {
		type: "success",
		thumbnail_buffer: result,
		edge_position: edgePosition,
		overlay_size: overlaySize,
		top_image_size: topImageSize,
		bottom_image_size: bottomImageSize,
		current_direction: currentDirection,
	};
};

export type ScrollScreenshotCaptureSize = {
	top_image_size: number;
	bottom_image_size: number;
};

export const scrollScreenshotGetSize = async () => {
	const result = await invoke<ScrollScreenshotCaptureSize>(
		"scroll_screenshot_get_size",
	);
	return result;
};

export const scrollScreenshotSaveToFile = async (filePath: string) => {
	const result = await invoke("scroll_screenshot_save_to_file", {
		filePath,
	});
	return result;
};

export const scrollScreenshotSaveToClipboard = async () => {
	const result = await invoke("scroll_screenshot_save_to_clipboard");
	return result;
};

export const scrollScreenshotClear = async () => {
	const result = await invoke("scroll_screenshot_clear");
	return result;
};

export const scrollScreenshotGetImageData = async (
	forceToPng: boolean = false,
): Promise<ArrayBuffer | undefined> => {
	let result: ArrayBuffer | undefined;
	try {
		result = await invoke<ArrayBuffer>("scroll_screenshot_get_image_data", {
			forceToPng,
		});
	} catch (error) {
		appError("[scrollScreenshotGetImageData] error", formatErrorDetails(error));
		return undefined;
	}

	if (result.byteLength === 0) {
		return undefined;
	}

	return result;
};
