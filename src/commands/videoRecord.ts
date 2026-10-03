import { invoke } from "@tauri-apps/api/core";
import type {
	GifFormat,
	VideoCaptureBackend,
	VideoFormat,
} from "@/types/appSettings";
import { getPlatform } from "@/utils/platform";

export const videoRecordStart = async (
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
	outputFile: string,
	format: VideoFormat,
	frameRate: number,
	enableMicrophone: boolean,
	enableSystemAudio: boolean,
	microphoneDeviceName: string,
	hwaccel: boolean,
	encoder: string,
	encoderPreset: string,
	videoMaxWidth: number,
	videoMaxHeight: number,
	captureBackend?: VideoCaptureBackend,
	captureCursor?: boolean,
) => {
	const result = await invoke("video_record_start", {
		minX,
		minY,
		maxX,
		maxY,
		outputFile,
		format,
		frameRate,
		enableMicrophone,
		enableSystemAudio,
		microphoneDeviceName,
		hwaccel,
		encoder,
		encoderPreset,
		videoMaxWidth,
		videoMaxHeight,
captureBackend,
	captureCursor,
	});
	return result;
};

export const videoRecordStop = async (
	convertToGif: boolean,
	gifFormat: GifFormat,
	gifFrameRate: number,
	gifMaxWidth: number,
	gifMaxHeight: number,
): Promise<string | null | undefined> => {
	const result = await invoke<string | null | undefined>("video_record_stop", {
		convertToGif,
		gifFormat,
		gifFrameRate,
		gifMaxWidth,
		gifMaxHeight,
	});
	return result;
};

export const videoRecordPause = async () => {
	const result = await invoke("video_record_pause");
	return result;
};

export const videoRecordResume = async () => {
	const result = await invoke("video_record_resume");
	return result;
};

export const videoRecordKill = async () => {
	const result = await invoke("video_record_kill");
	return result;
};

export const videoRecordGetMicrophoneDeviceNames = async () => {
	const result = await invoke<string[]>(
		"video_record_get_microphone_device_names",
	);
	return result;
};

export const videoRecordInit = async (ffmpegPluginDir: string) => {
	const result = await invoke("video_record_init", { ffmpegPluginDir });
	return result;
};

/**
 * 在用户点"开始录制"之前预热编码器（选区出现时调用）
 *
 * 让 ffmpeg/编码器的启动开销与硬件编码器的 GPU 启动停顿提前发生，
 * 点击开始后即可立即进入录制。
 */
export const videoRecordWarmup = async (
	encoder: string,
	encoderPreset: string,
	width: number,
	height: number,
	frameRate: number,
) => {
	const result = await invoke("video_record_warmup", {
		encoder,
		encoderPreset,
		width,
		height,
		frameRate,
	});
	return result;
};

export const setExcludeFromCapture = async (enable: boolean) => {
	if (getPlatform() === "macos") {
		return;
	}

	const result = await invoke("set_exclude_from_capture", { enable });
	return result;
};

export const showMainWindow = async (autoHide: boolean = false) => {
	const result = await invoke("show_main_window", { autoHide });
	return result;
};
