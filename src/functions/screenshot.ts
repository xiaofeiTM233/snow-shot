import { emit } from "@tauri-apps/api/event";
import { saveFile } from "@/commands";
import { captureFocusedWindow } from "@/commands/screenshot";
import { copyToClipboard } from "@/pages/draw/actions";

import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import { getCorrectHdrColorAlgorithm } from "@/utils/appSettings";
import { playCameraShutterSound } from "@/utils/audio";
import { getImagePathFromSettings } from "@/utils/file";
import { appError, appInfo } from "@/utils/log";
import { ScreenshotType } from "@/utils/types";

export const executeScreenshot = async (
	type: ScreenshotType = ScreenshotType.Default,
	windowLabel?: string,
	captureHistoryId?: string,
) => {
	appInfo("[DIAG] executeScreenshot: emit start", {
		type,
		windowLabel,
		captureHistoryId,
	});
	try {
		await emit("execute-screenshot", {
			type,
			windowLabel,
			captureHistoryId,
		});
		appInfo("[DIAG] executeScreenshot: emit success");
	} catch (error) {
		appError("[DIAG] executeScreenshot: emit failed", error);
	}
};

export const executeScreenshotFocusedWindow = async (
	appSettings: AppSettingsData,
) => {
	let imageBuffer: Awaited<ReturnType<typeof captureFocusedWindow>> | undefined;

	try {
		const captureFocusedWindowPromise = captureFocusedWindow(
			getCorrectHdrColorAlgorithm(appSettings),
		);
		playCameraShutterSound();
		imageBuffer = await captureFocusedWindowPromise;
	} catch (error) {
		appError(
			"[executeScreenshotFocusedWindow] Failed to capture focused window",
			error,
		);
		return;
	}

	if (!imageBuffer) {
		appError(
			"[executeScreenshotFocusedWindow] Failed to capture focused window, imageBuffer is undefined",
		);
		return;
	}

	// 前端检查 autoSaveOnCopy 配置，遵循区域截图的逻辑
	const enableAutoSave =
		appSettings[AppSettingsGroup.FunctionScreenshot].autoSaveOnCopy;
	const enableFocusedAutoSave =
		appSettings[AppSettingsGroup.FunctionScreenshot]
			.focusedWindowCopyToClipboard;

	// 复制到剪贴板
	if (enableFocusedAutoSave) {
		try {
			await copyToClipboard(imageBuffer.buffer, appSettings, undefined);
		} catch (error) {
			appError(
				"[executeScreenshotFocusedWindow] Failed to copy to clipboard",
				error,
			);
		}
	}

	// 保存到文件
	if (enableAutoSave) {
		const imagePath = await getImagePathFromSettings(
			appSettings,
			"focused-window",
		);
		if (imagePath) {
			try {
				await saveFile(
					imagePath.filePath,
					imageBuffer.buffer,
					imagePath.imageFormat,
				);
			} catch (error) {
				appError("[executeScreenshotFocusedWindow] Failed to save file", error);
			}
		}
	}
};

export const finishScreenshot = async () => {
	await emit("finish-screenshot");
};

export const releaseDrawPage = async (force: boolean = false) => {
	await emit("release-draw-page", {
		force,
	});
};

export const onCaptureHistoryChange = async () => {
	await emit("on-capture-history-change");
};
