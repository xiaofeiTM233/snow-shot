import { join as joinPath, pictureDir, videoDir } from "@tauri-apps/api/path";
import * as dialog from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { createDir } from "@/commands/file";
import { getFocusedWindowAppName } from "@/commands/screenshot";
import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import { ImageFormat, type ImagePath } from "@/types/utils/file";

const parseTemplate = (template: string, appName?: string): string => {
	const regex = /\{\{([^}]+)\}\}/g;

	return template.replace(regex, (match, content) => {
		if (content === "FOCUS_WINDOW_APP_NAME") {
			return appName ?? "Unknown";
		}
		if (content.match(/^[YMDHmsSaA\-_:\s/.]+$/)) {
			return dayjs().format(content);
		}
		return match;
	});
};

/**
 * 生成图片文件名
 * @param format 格式模板，例如 "SnowShot_{YYYY-MM-DD_HH-mm-ss-SSS}"
 * @param appName 可选的窗口应用名称
 * @returns 生成的文件名
 */
export const generateImageFileName = (format: string, appName?: string) => {
	if (!format) {
		return "";
	}

	return parseTemplate(format, appName);
};

export const joinImagePath = (filePath: string, imageFormat: ImageFormat) => {
	let fileExtension = "png";
	switch (imageFormat) {
		case ImageFormat.JPEG:
			fileExtension = "jpg";
			break;
		case ImageFormat.WEBP:
			fileExtension = "webp";
			break;
		case ImageFormat.AVIF:
			fileExtension = "avif";
			break;
		case ImageFormat.JPEG_XL:
			fileExtension = "jxl";
			break;
		case ImageFormat.PNG:
			fileExtension = "png";
			break;
	}

	return `${filePath}.${fileExtension}`;
};

export const getImageFormat = (filePath: string) => {
	let imageFormat = ImageFormat.PNG;
	if (filePath.endsWith(".jpg")) {
		imageFormat = ImageFormat.JPEG;
	} else if (filePath.endsWith(".webp")) {
		imageFormat = ImageFormat.WEBP;
	} else if (filePath.endsWith(".avif")) {
		imageFormat = ImageFormat.AVIF;
	} else if (filePath.endsWith(".jxl")) {
		imageFormat = ImageFormat.JPEG_XL;
	}

	return imageFormat;
};

export const getImageSaveDirectory = async (appSettings: AppSettingsData) => {
	let savePath =
		appSettings[AppSettingsGroup.FunctionScreenshot].saveFileDirectory;

	if (!savePath) {
		savePath = await joinPath(await pictureDir(), "Snow Shot");
	}

	return savePath;
};

export const getImagePathFromSettings = async (
	appSettings: AppSettingsData | undefined,
	method: "auto" | "fast" | "focused-window" | "full-screen",
): Promise<ImagePath | undefined> => {
	if (!appSettings) {
		return undefined;
	}

	const screenshotSettings = appSettings[AppSettingsGroup.FunctionScreenshot];
	const outputSettings = appSettings[AppSettingsGroup.FunctionOutput];

	if (!screenshotSettings || !outputSettings) {
		return undefined;
	}

	let fileName = "";
	switch (method) {
		case "auto":
			fileName = generateImageFileName(outputSettings.autoSaveFileNameFormat);
			break;
		case "fast":
			fileName = generateImageFileName(outputSettings.fastSaveFileNameFormat);
			break;
		case "focused-window": {
			const appName = await getFocusedWindowAppName();
			fileName = generateImageFileName(
				outputSettings.focusedWindowFileNameFormat,
				appName || "Screenshot",
			);
			break;
		}
		case "full-screen":
			fileName = generateImageFileName(outputSettings.fullScreenFileNameFormat);
			break;
	}

	const saveDirectory = await getImageSaveDirectory(appSettings);
	await createDir(saveDirectory);

	return {
		filePath: joinImagePath(
			await joinPath(saveDirectory, fileName),
			screenshotSettings.saveFileFormat,
		),
		imageFormat: screenshotSettings.saveFileFormat,
	};
};

export const showImageDialog = async (
	appSettings: AppSettingsData,
	prevFormat?: ImageFormat,
): Promise<ImagePath | undefined> => {
	let firstFilter: { name: string; extensions: string[] };
	switch (prevFormat) {
		case ImageFormat.JPEG:
			firstFilter = {
				name: "JPEG(*.jpg)",
				extensions: ["jpg"],
			};
			break;
		case ImageFormat.WEBP:
			firstFilter = {
				name: "WebP(*.webp)",
				extensions: ["webp"],
			};
			break;
		case ImageFormat.AVIF:
			firstFilter = {
				name: "AVIF(*.avif)",
				extensions: ["avif"],
			};
			break;
		case ImageFormat.JPEG_XL:
			firstFilter = {
				name: "JPEG XL(*.jxl)",
				extensions: ["jxl"],
			};
			break;
		default:
			firstFilter = {
				name: "PNG(*.png)",
				extensions: ["png"],
			};
			break;
	}

	const filePath = await dialog.save({
		filters: [
			firstFilter,
			{
				name: "PNG(*.png)",
				extensions: ["png"],
			},
			{
				name: "JPEG(*.jpg)",
				extensions: ["jpg"],
			},
			{
				name: "WebP(*.webp)",
				extensions: ["webp"],
			},
			{
				name: "AVIF(*.avif)",
				extensions: ["avif"],
			},
			{
				name: "JPEG XL(*.jxl)",
				extensions: ["jxl"],
			},
		],
		defaultPath: generateImageFileName(
			appSettings[AppSettingsGroup.FunctionOutput].manualSaveFileNameFormat,
		),
		canCreateDirectories: true,
	});

	if (!filePath) {
		return;
	}

	return {
		filePath,
		imageFormat: getImageFormat(filePath),
	};
};

export const getVideoRecordSaveDirectory = async (
	appSettings: AppSettingsData,
) => {
	let savePath =
		appSettings[AppSettingsGroup.FunctionVideoRecord].saveDirectory;

	if (!savePath) {
		savePath = await joinPath(await videoDir(), "Snow Shot");
	}

	return savePath;
};
