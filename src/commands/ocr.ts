import { invoke } from "@tauri-apps/api/core";
import type { OcrDetectResult } from "@/types/commands/ocr";
import type { OnlineOcrConfig } from "@/types/appSettings";

export const ocrDetect = async (
	data: ArrayBuffer | Uint8Array,
	scaleFactor: number,
	detectAngle: boolean,
): Promise<OcrDetectResult> => {
	return await invoke<OcrDetectResult>("ocr_detect", data, {
		headers: {
			"x-scale-factor": scaleFactor.toFixed(3),
			"x-detect-angle": detectAngle ? "true" : "false",
		},
	});
};

export const ocrDetectWithSharedBuffer = async (
	channelId: string,
	scaleFactor: number,
	detectAngle: boolean,
): Promise<OcrDetectResult> => {
	return await invoke<OcrDetectResult>("ocr_detect_with_shared_buffer", {
		channelId,
		scaleFactor,
		detectAngle,
	});
};

export const ocrInit = async (
	orcPluginPath: string,
	detModel: string | null,
	clsModel: string | null,
	recModel: string | null,
	hotStart: boolean,
	modelWriteToMemory: boolean,
): Promise<void> => {
	await invoke<void>("ocr_init", {
		orcPluginPath,
		detModel,
		clsModel,
		recModel,
		hotStart,
		modelWriteToMemory,
	});
};

export const ocrRelease = async (): Promise<void> => {
	await invoke<void>("ocr_release");
};

export const listOcrModelFiles = async (dirPath: string): Promise<string[]> => {
	return await invoke<string[]>("list_ocr_model_files", { dirPath });
};

export const onlineOcrDetect = async (
	data: ArrayBuffer | Uint8Array,
	config: OnlineOcrConfig,
): Promise<OcrDetectResult> => {
	return await invoke<OcrDetectResult>("online_ocr_detect", data, {
		headers: {
			"x-online-ocr-config": JSON.stringify(config),
		},
	});
};
