import { invoke } from "@tauri-apps/api/core";
import type { TencentApiConfig, YoudaoApiConfig } from "@/types/appSettings";

/** 图片翻译结果中的一行（区域或行级），坐标相对原图左上角 */
export type MachineTranslatedImageLine = {
	source_text: string;
	translated_text: string;
	box_x: number;
	box_y: number;
	box_width: number;
	box_height: number;
};

export const translateTextYoudao = async (
	config: Pick<YoudaoApiConfig, "app_key" | "app_secret">,
	texts: string[],
	from: string,
	to: string,
): Promise<string[]> => {
	return await invoke<string[]>("translate_text_youdao", {
		appKey: config.app_key,
		appSecret: config.app_secret,
		texts,
		from,
		to,
	});
};

export const translateTextTencent = async (
	config: Pick<TencentApiConfig, "secret_id" | "secret_key" | "region">,
	texts: string[],
	from: string,
	to: string,
): Promise<string[]> => {
	return await invoke<string[]>("translate_text_tencent", {
		secretId: config.secret_id,
		secretKey: config.secret_key,
		region: config.region,
		texts,
		from,
		to,
	});
};

export const translateImageYoudao = async (
	data: ArrayBuffer | Uint8Array,
	config: Pick<YoudaoApiConfig, "app_key" | "app_secret"> & {
		from: string;
		to: string;
	},
): Promise<MachineTranslatedImageLine[]> => {
	return await invoke<MachineTranslatedImageLine[]>(
		"translate_image_youdao",
		data,
		{
			headers: {
				"x-translation-config": encodeURIComponent(JSON.stringify(config)),
			},
		},
	);
};

export const translateImageTencent = async (
	data: ArrayBuffer | Uint8Array,
	config: Pick<TencentApiConfig, "secret_id" | "secret_key" | "region"> & {
		to: string;
	},
): Promise<MachineTranslatedImageLine[]> => {
	return await invoke<MachineTranslatedImageLine[]>(
		"translate_image_tencent",
		data,
		{
			headers: {
				"x-translation-config": encodeURIComponent(JSON.stringify(config)),
			},
		},
	);
};
