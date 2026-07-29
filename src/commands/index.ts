import { invoke } from "@tauri-apps/api/core";
import { Base64 } from "js-base64";
import {
	type ElementRect,
	type ImageBuffer,
	ImageBufferType,
	type ImageEncoder,
	type WindowElement,
} from "@/types/commands/screenshot";
import type { ImageFormat } from "@/types/utils/file";

/**
 * 捕获鼠标所在位置的屏幕图像
 */
export const captureCurrentMonitor = async (
	encoder: ImageEncoder,
): Promise<ImageBuffer | undefined> => {
	const result = await invoke<ArrayBuffer>("capture_current_monitor", {
		encoder,
	});

	if (result.byteLength === 0) {
		return undefined;
	}

	return {
		encoder,
		data: new Blob([result]),
		bufferType: ImageBufferType.Pixels,
		buffer: result,
	};
};

export const getWindowElements = async (blacklist?: string[]) => {
	const result = await invoke<WindowElement[]>("get_window_elements", {
		blacklist: blacklist && blacklist.length > 0 ? blacklist : null,
	});
	return result;
};

export const initUiElementsCache = async (blacklist?: string[]) => {
	const result = await invoke<void>("init_ui_elements_cache", {
		blacklist: blacklist && blacklist.length > 0 ? blacklist : null,
	});
	return result;
};

export const initUiElements = async () => {
	const result = await invoke<void>("init_ui_elements");
	return result;
};

export const getElementFromPosition = async (
	mouseX: number,
	mouseY: number,
	mode: string = "fine",
	includeChildWindows: boolean = true,
) => {
	const result = await invoke<ElementRect[]>("get_element_from_position", {
		mouseX,
		mouseY,
		mode,
		includeChildWindows,
	});
	return result;
};

export const exitApp = async () => {
	const result = await invoke<void>("exit_app");
	return result;
};

export const getMousePosition = async () => {
	const result = await invoke<[number, number]>("get_mouse_position");
	return result;
};

export const saveFile = async (
	filePath: string,
	data: ArrayBuffer | Uint8Array,
	fileType: ImageFormat,
) => {
	const result = await invoke<void>("save_file", data, {
		headers: {
			"x-file-path": Base64.encode(filePath),
			"x-file-type": Base64.encode(fileType),
		},
	});
	return result;
};

export const createDrawWindow = async () => {
	const result = await invoke<void>("create_draw_window");
	return result;
};
