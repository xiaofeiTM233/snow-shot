import { compare } from "compare-versions";
import {
	type AppSettingsData,
	AppSettingsGroup,
	HdrColorAlgorithm,
	HdrColorCorrection,
	CaptureMethod,
} from "@/types/appSettings";
import { appInfo } from "./log";
import { getPlatform, getPlatformVersion } from "./platform";

/**
 * Windows 10 2004 (May 2020 Update) 的版本号
 * HDR 颜色校正需要此版本或更高版本
 */
const MIN_WINDOWS_VERSION_FOR_HDR = "10.0.19041";

export const getCorrectHdrColorAlgorithm = (
	appSettings: AppSettingsData,
	compareMinimumVersion?: boolean,
) => {
	// 检查是否为 Windows 平台
	if (getPlatform() !== "windows") {
		return HdrColorAlgorithm.None;
	}

	// 检查 Windows 版本是否满足最低要求（高于 Windows 10 2004）
	if (compareMinimumVersion) {
		const currentVersion = getPlatformVersion();
		if (compare(currentVersion, MIN_WINDOWS_VERSION_FOR_HDR, "<=")) {
			appInfo(
				`[getCorrectHdrColorAlgorithm] currentVersion: ${currentVersion} is less than ${MIN_WINDOWS_VERSION_FOR_HDR}`,
			);
			return HdrColorAlgorithm.None;
		}
	}

	// 用户是否启用 HDR 颜色校正
	return appSettings[AppSettingsGroup.SystemScreenshot].hdrColorCorrection ===
		HdrColorCorrection.Linear
		? HdrColorAlgorithm.Linear
		: HdrColorAlgorithm.None;
};

/** 获取采集方式（Wgc / Xcap） */
export const getCaptureMethod = (appSettings: AppSettingsData) => {
	return appSettings[AppSettingsGroup.SystemScreenshot].captureMethod;
};
