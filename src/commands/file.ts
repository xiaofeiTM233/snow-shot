import { invoke } from "@tauri-apps/api/core";
import { Base64 } from "js-base64";

export const writeFile = async (
	filePath: string,
	data: ArrayBuffer | Uint8Array,
) => {
	const result = await invoke<void>("write_file", data, {
		headers: {
			"x-file-path": Base64.encode(filePath),
		},
	});
	return result;
};

export const copyFile = async (from: string, to: string) => {
	const result = await invoke<void>("copy_file", { from, to });
	return result;
};

export const removeFile = async (filePath: string) => {
	const result = await invoke<void>("remove_file", { filePath });
	return result;
};

export const createDir = async (dirPath: string) => {
	const result = await invoke<void>("create_dir", {
		dirPath,
	});
	return result;
};

export const createLocalConfigDir = async (path: string) => {
	const result = await invoke<void>("create_local_config_dir", { path });
	return result;
};

export const removeDir = async (dirPath: string) => {
	const result = await invoke<void>("remove_dir", { dirPath });
	return result;
};

export const textFileRead = async (filePath: string) => {
	const result = await invoke<string>("text_file_read", { filePath });
	return result;
};

export const textFileWrite = async (filePath: string, content: string) => {
	const result = await invoke<void>("text_file_write", { filePath, content });
	return result;
};

export const textFileClear = async () => {
	const result = await invoke<void>("text_file_clear");
	return result;
};

export const getAppConfigDir = async () => {
	const result = await invoke<string>("get_app_config_dir");
	return result;
};

export const getAppConfigBaseDir = async () => {
	const result = await invoke<string>("get_app_config_base_dir");
	return result;
};

export const getAppCacheDir = async () => {
	const result = await invoke<string>("get_app_cache_dir");
	return result;
};

export const createLocalCacheDir = async (path: string) => {
	const result = await invoke<void>("create_local_cache_dir", { path });
	return result;
};

export const isPortableApp = async () => {
	const result = await invoke<boolean>("is_portable_app");
	return result;
};
