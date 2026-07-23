import { invoke } from "@tauri-apps/api/core";
import type { MonitorRect } from "@/pages/draw/extra";
import type { ElementRect } from "@/types/commands/screenshot";
import type { ResizeWindowSide } from "@/utils/types";

export const getSelectedText = async () => {
	const result = await invoke<string>("get_selected_text");
	return result;
};

export const setEnableProxy = async (enable: boolean) => {
	const result = await invoke<string>("set_enable_proxy", {
		enable,
		host: "127.0.0.1,localhost,snowshot.top,120.79.232.67,snowshot.mgchao.top",
	});
	return result;
};

export const scrollThrough = async (length: number) => {
	const result = await invoke<void>("scroll_through", {
		length,
	});
	return result;
};

export const clickThrough = async () => {
	const result = await invoke<void>("click_through");
	return result;
};

export const autoScrollThrough = async (
	direction: "vertical" | "horizontal",
	length: number,
) => {
	const result = await invoke<void>("auto_scroll_through", {
		direction,
		length,
	});
	return result;
};

export const createFixedContentWindow = async (scrollScreenshot?: boolean) => {
	const result = await invoke<void>("create_fixed_content_window", {
		scrollScreenshot: scrollScreenshot ?? false,
	});
	return result;
};

export const readImageFromClipboard = async (): Promise<
	ArrayBuffer | undefined
> => {
	const result = await invoke<ArrayBuffer>("read_image_from_clipboard");

	if (result.byteLength === 0) {
		return undefined;
	}

	return result;
};

export const createFullScreenDrawWindow = async () => {
	const result = await invoke<void>("create_full_screen_draw_window");
	return result;
};

export const closeFullScreenDrawWindow = async () => {
	const result = await invoke<void>("close_full_screen_draw_window");
	return result;
};

export type MonitorInfo = {
	monitor_x: number;
	monitor_y: number;
	monitor_width: number;
	monitor_height: number;
	monitor_scale_factor: number;
	mouse_x: number;
	mouse_y: number;
};

export const getCurrentMonitorInfo = async () => {
	const result = await invoke<MonitorInfo>("get_current_monitor_info");
	return result;
};

export const enableFreeDrag = async () => {
	const result = await invoke<void>("enable_free_drag");
	return result;
};

export const startFreeDrag = async () => {
	const result = await invoke<void>("start_free_drag");
	return result;
};

export const startResizeWindow = async (
	side: ResizeWindowSide,
	spectRatio: number,
	minWidth: number,
	maxWidth: number,
) => {
	const result = await invoke<void>("start_resize_window", {
		side,
		spectRatio,
		minWidth,
		maxWidth,
	});
	return result;
};

export const sendNewVersionNotification = async (
	title: string,
	body: string,
) => {
	const result = await invoke<void>("send_new_version_notification", {
		title,
		body,
	});
	return result;
};

export const createVideoRecordWindow = async (
	selectRectMinX: number,
	selectRectMinY: number,
	selectRectMaxX: number,
	selectRectMaxY: number,
) => {
	const result = await invoke<void>("create_video_record_window", {
		selectRectMinX,
		selectRectMinY,
		selectRectMaxX,
		selectRectMaxY,
	});
	return result;
};

export const closeVideoRecordWindow = async () => {
	const result = await invoke<void>("close_video_record_window");
	return result;
};

export const hasVideoRecordWindow = async () => {
	const result = await invoke<boolean>("has_video_record_window");
	return result;
};

/**
 * 设置当前窗口置顶
 * @param allowInputMethodOverlay 是否允许输入法覆盖
 */
export const setCurrentWindowAlwaysOnTop = async (
	allowInputMethodOverlay: boolean,
) => {
	const result = await invoke<void>("set_current_window_always_on_top", {
		allowInputMethodOverlay,
	});
	return result;
};

export type MonitorBoundingBox = {
	rect: ElementRect;
	monitor_rect_list: MonitorRect[];
};

export const getMonitorsBoundingBox = async (
	region: ElementRect | undefined,
	enableMultipleMonitor: boolean,
) => {
	const result = await invoke<MonitorBoundingBox>("get_monitors_bounding_box", {
		region,
		enableMultipleMonitor,
	});
	return result;
};

export const closeWindowAfterDelay = async (delay: number) => {
	const result = await invoke<void>("close_window_after_delay", {
		delay,
	});
	return result;
};

export const autoStartEnable = async () => {
	const result = await invoke<void>("auto_start_enable");
	return result;
};

export const autoStartDisable = async () => {
	const result = await invoke<void>("auto_start_disable");
	return result;
};

export const restartWithAdmin = async () => {
	const result = await invoke<void>("restart_with_admin");
	return result;
};

export const restart = async () => {
	const result = await invoke<void>("restart");
	return result;
};

export const writeBitmapImageToClipboard = async (image: ArrayBuffer) => {
	const result = await invoke<void>("write_bitmap_image_to_clipboard", image);
	return result;
};

export const writeBitmapImageToClipboardWithSharedBuffer = async (
	channelId: string,
) => {
	const result = await invoke<void>(
		"write_bitmap_image_to_clipboard_with_shared_buffer",
		{ channelId },
	);
	return result;
};

export const retainDirFiles = async (dirPath: string, fileNames: string[]) => {
	const result = await invoke<void>("retain_dir_files", {
		dirPath,
		fileNames,
	});
	return result;
};

export const isAdmin = async () => {
	const result = await invoke<boolean>("is_admin");
	return result;
};

export const setRunLog = async (level: string) => {
	const result = await invoke<void>("set_run_log", {
		level,
	});
	return result;
};

export const setProcessPriority = async (enable: boolean) => {
	const result = await invoke<void>("set_process_priority", {
		enable,
	});
	return result;
};

export const writeImagePixelsToClipboardWithSharedBuffer = async (
	channelId: string,
) => {
	const result = await invoke<void>(
		"write_image_pixels_to_clipboard_with_shared_buffer",
		{ channelId },
	);
	return result;
};

/**
 * 是否有全屏窗口被聚焦
 */
export const hasFocusedFullScreenWindow = async () => {
	const result = await invoke<boolean>("has_focused_full_screen_window");
	return result;
};

export const setWindowRect = async (
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
) => {
	const result = await invoke("set_window_rect", { minX, minY, maxX, maxY });
	return result;
};

export const getCommitSha = async () => {
	const result = await invoke<string>("get_commit_sha");
	return result;
};

export const setRememberWindowGeometry = async (remember: boolean) => {
	await invoke("set_remember_window_geometry", { remember });
};
