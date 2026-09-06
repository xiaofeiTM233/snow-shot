import { emit } from "@tauri-apps/api/event";
import { ONLINE_OCR_MODEL_PREFIX } from "@/constants/appSettings";
import type {
	AppSettingsData,
	AppSettingsGroup,
	OnlineOcrModelConfig,
} from "@/types/appSettings";

export const releaseOcrSession = async () => {
	await emit("release-ocr-session");
};

/** 当前选中的文本识别模型是否为在线 OCR 模型，是则返回对应的在线 OCR 配置 */
export const findSelectedOnlineOcrConfig = (
	ocrSettings: AppSettingsData[AppSettingsGroup.FunctionOcr],
): OnlineOcrModelConfig | undefined => {
	const ocrModel = ocrSettings.ocrModel;
	if (!ocrModel.startsWith(ONLINE_OCR_MODEL_PREFIX)) {
		return undefined;
	}

	if (!Array.isArray(ocrSettings.onlineOcrModelConfigList)) {
		return undefined;
	}

	const modelName = ocrModel.substring(ONLINE_OCR_MODEL_PREFIX.length);
	return ocrSettings.onlineOcrModelConfigList.find(
		(config) => config.model_name === modelName,
	);
};
