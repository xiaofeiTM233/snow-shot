import { invoke } from "@tauri-apps/api/core";
import type {
	GifFormat,
	RecordPixelFormat,
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
	pixelFormat?: RecordPixelFormat,
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
		pixelFormat,
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
