import { invoke } from "@tauri-apps/api/core";
import {
	TranslationApiType,
	type TencentApiConfig,
	type YoudaoApiConfig,
} from "@/types/appSettings";

/** 在线翻译服务提供方 */
export type OnlineTranslationProvider = "youdao" | "tencent";

/** 在线翻译配置，按提供方提供对应凭据 */
export type OnlineTranslationConfig = {
	provider: OnlineTranslationProvider;
	/** 有道 应用ID（appKey） */
	app_key?: string;
	/** 有道 应用密钥 */
	app_secret?: string;
	/** 腾讯云 SecretId */
	secret_id?: string;
	/** 腾讯云 SecretKey */
	secret_key?: string;
	/** 腾讯云 地域 */
	region?: string;
	/** 源语言 */
	from?: string;
	/** 目标语言 */
	to?: string;
};

/** 图片翻译结果中的一行（区域或行级），坐标相对原图左上角 */
export type MachineTranslatedImageLine = {
	source_text: string;
	translated_text: string;
	box_x: number;
	box_y: number;
	box_width: number;
	box_height: number;
};

/** 从翻译 API 配置中提取在线翻译所需的提供方与凭据 */
export const toOnlineTranslationConfig = (
	apiConfig: YoudaoApiConfig | TencentApiConfig,
): OnlineTranslationConfig => {
	if (apiConfig.api_type === TranslationApiType.Youdao) {
		return {
			provider: "youdao",
			app_key: apiConfig.app_key,
			app_secret: apiConfig.app_secret,
		};
	}

	return {
		provider: "tencent",
		secret_id: apiConfig.secret_id,
		secret_key: apiConfig.secret_key,
		region: apiConfig.region,
	};
};

const translationRequestHeaders = (config: OnlineTranslationConfig) => ({
	headers: {
		"x-translation-config": encodeURIComponent(JSON.stringify(config)),
	},
});

export const translateText = async (
	config: OnlineTranslationConfig,
	texts: string[],
	from: string,
	to: string,
): Promise<string[]> => {
	return await invoke<string[]>(
		"translate_text",
		new TextEncoder().encode(JSON.stringify(texts)),
		translationRequestHeaders({ ...config, from, to }),
	);
};

export const translateImage = async (
	config: OnlineTranslationConfig,
	data: ArrayBuffer | Uint8Array,
	from: string,
	to: string,
): Promise<MachineTranslatedImageLine[]> => {
	return await invoke<MachineTranslatedImageLine[]>(
		"translate_image",
		data,
		translationRequestHeaders({ ...config, from, to }),
	);
};
