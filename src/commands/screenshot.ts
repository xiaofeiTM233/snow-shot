import { invoke } from "@tauri-apps/api/core";
import type { HdrColorAlgorithm, CaptureMethod } from "@/types/appSettings";
import {
	type ImageBuffer,
	ImageBufferType,
	ImageEncoder,
} from "@/types/commands/screenshot";

export const switchAlwaysOnTop = async (windowId: number) => {
	const result = await invoke<string>("switch_always_on_top", {
		windowId,
	});
	return result;
};

export const setDrawWindowStyle = async () => {
	const result = await invoke("set_draw_window_style");
	return result;
};

/**
 * 捕获焦点窗口
 * @returns 图像数据（ImageBuffer）
 */
export const captureFocusedWindow = async (
	correctHdrColorAlgorithm: HdrColorAlgorithm,
	captureMethod: CaptureMethod,
): Promise<ImageBuffer | undefined> => {
	const result = await invoke<ArrayBuffer>("capture_focused_window", {
		correctHdrColorAlgorithm,
		captureMethod,
	});

	if (result.byteLength === 0) {
		return undefined;
	}

	return {
		encoder: ImageEncoder.Png,
		data: new Blob([result]),
		buffer: result,
		bufferType: ImageBufferType.Pixels,
	};
};

/** 获取当前焦点窗口的应用名称 */
export const getFocusedWindowAppName = (): Promise<string> => {
	return invoke<string>("get_focused_window_app_name");
};

export const captureAllMonitors = async (
	enableMultipleMonitor: boolean,
	correctHdrColorAlgorithm: HdrColorAlgorithm,
	correctColorFilter: boolean,
	captureMethod: CaptureMethod,
): Promise<ImageBuffer | undefined> => {
	const result = await invoke<ArrayBuffer>("capture_all_monitors", {
		enableMultipleMonitor,
		correctHdrColorAlgorithm,
		correctColorFilter,
		captureMethod,
	});

	if (result.byteLength === 0) {
		return undefined;
	}

	let type = ImageBufferType.Pixels;
	if (result.byteLength === 1) {
		if (new Uint8Array(result)[0] === 1) {
			type = ImageBufferType.SharedBuffer;
		}
	}

	return {
		encoder: ImageEncoder.Png,
		data: new Blob([result]),
		buffer: result,
		bufferType: type,
	};
};

export const captureFullScreen = async (
	enableMultipleMonitor: boolean,
	captureHistoryFilePath: string,
	correctHdrColorAlgorithm: HdrColorAlgorithm,
	correctColorFilter: boolean,
	captureMethod: CaptureMethod,
): Promise<ImageBuffer | undefined> => {
	const result = await invoke<ArrayBuffer>("capture_full_screen", {
		enableMultipleMonitor,
		captureHistoryFilePath,
		correctHdrColorAlgorithm,
		correctColorFilter,
		captureMethod,
	});

	if (result.byteLength === 0) {
		return undefined;
	}

	return {
		encoder: ImageEncoder.Png,
		data: new Blob([result]),
		buffer: result,
		bufferType: ImageBufferType.Pixels,
	};
};
