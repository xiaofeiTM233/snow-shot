import { useCallback, useEffect, useRef, useState } from "react";
import { initUiElements } from "@/commands";
import {
	autoStartDisable,
	autoStartEnable,
	setEnableProxy,
	setProcessPriority,
	setRunLog,
} from "@/commands/core";
import { hotLoadPageInit } from "@/commands/hotLoadPage";
import { ocrInit } from "@/commands/ocr";
import { videoRecordInit } from "@/commands/videoRecord";
import {
	PLUGIN_ID_FFMPEG,
	PLUGIN_ID_RAPID_OCR,
} from "@/constants/pluginService";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { usePlatform } from "@/hooks/usePlatform";
import { type AppSettingsData, AppSettingsGroup, OcrModel } from "@/types/appSettings";
import { CaptureHistory } from "@/utils/captureHistory";
import { appWarn } from "@/utils/log";

export const InitService = () => {
	// 清除无效的截图历史
	const clearCaptureHistory = useCallback(
		async (appSettings: AppSettingsData) => {
			const captureHistory = new CaptureHistory();
			await captureHistory.init();
			await captureHistory.clearExpired(appSettings);
		},
		[],
	);

	const hasInitOcr = useRef(false);
	const hasClearedCaptureHistory = useRef(false);
	const hasInitAutoStart = useRef(false);
	const hasInitEnableProxy = useRef(false);
	const hasInitRunLog = useRef(false);
	const hasInitBoostProcessPriority = useRef(false);
	const hasInitHotLoadPage = useRef(false);

	const [appSettings, setAppSettings] = useState<AppSettingsData | undefined>(
		undefined,
	);
	const [prevAppSettings, setPrevAppSettings] = useState<
		AppSettingsData | undefined
	>(undefined);

	const { isReadyStatus, pluginConfigRef } = usePluginServiceContext();

	const [currentPlatform] = usePlatform();

	const initServices = useCallback(async () => {
		if (!appSettings || !isReadyStatus) {
			return;
		}

		if (
			(!hasInitOcr.current ||
				(prevAppSettings &&
					(appSettings[AppSettingsGroup.FunctionOcr].ocrModel !==
						prevAppSettings[AppSettingsGroup.FunctionOcr].ocrModel ||
						appSettings[AppSettingsGroup.SystemScreenshot].ocrHotStart !==
							prevAppSettings[AppSettingsGroup.SystemScreenshot].ocrHotStart ||
						appSettings[AppSettingsGroup.SystemScreenshot]
							.ocrModelWriteToMemory !==
							prevAppSettings[AppSettingsGroup.SystemScreenshot]
								.ocrModelWriteToMemory))) &&
			isReadyStatus(PLUGIN_ID_RAPID_OCR)
		) {
			hasInitOcr.current = true;

			if (pluginConfigRef.current) {
				const ocrSettings = appSettings[AppSettingsGroup.FunctionOcr];
				let detModel: string | null = null;
				let clsModel: string | null = null;
				let recModel: string | null = null;

				if (ocrSettings.ocrModel !== OcrModel.RapidOcrV4) {
					const customConfig = ocrSettings.customOcrModelConfigList.find(
						(c) => c.model_name === ocrSettings.ocrModel,
					);
					if (customConfig) {
						detModel = customConfig.det_model || null;
						clsModel = customConfig.cls_model || null;
						recModel = customConfig.rec_model || null;
					}
				}

				ocrInit(
					await pluginConfigRef.current.getPluginDirPath(PLUGIN_ID_RAPID_OCR),
					detModel,
					clsModel,
					recModel,
					appSettings[AppSettingsGroup.SystemScreenshot].ocrHotStart,
					appSettings[AppSettingsGroup.SystemScreenshot].ocrModelWriteToMemory,
				);
			} else {
				appWarn("[InitService] pluginConfigRef.current is not set");
			}
		}

		if (!hasClearedCaptureHistory.current) {
			hasClearedCaptureHistory.current = true;

			clearCaptureHistory(appSettings);
		}

		if (
			!hasInitEnableProxy.current ||
			(prevAppSettings &&
				appSettings[AppSettingsGroup.SystemNetwork].enableProxy !==
					prevAppSettings[AppSettingsGroup.SystemNetwork].enableProxy)
		) {
			hasInitEnableProxy.current = true;

			setEnableProxy(appSettings[AppSettingsGroup.SystemNetwork].enableProxy);
		}

		if (
			process.env.NODE_ENV !== "development" &&
			(!hasInitAutoStart.current ||
				(prevAppSettings &&
					appSettings[AppSettingsGroup.SystemCommon].autoStart !==
						prevAppSettings[AppSettingsGroup.SystemCommon].autoStart))
		) {
			hasInitAutoStart.current = true;

			if (appSettings[AppSettingsGroup.SystemCommon].autoStart) {
				autoStartEnable();
			} else {
				autoStartDisable();
			}
		}

		if (
			!hasInitRunLog.current ||
			(prevAppSettings &&
				appSettings[AppSettingsGroup.SystemCommon].runLog !==
					prevAppSettings[AppSettingsGroup.SystemCommon].runLog)
		) {
			hasInitRunLog.current = true;

			setRunLog(appSettings[AppSettingsGroup.SystemCommon].runLog);
		}

		if (
			currentPlatform === "windows" &&
			(!hasInitBoostProcessPriority.current ||
				(prevAppSettings &&
					appSettings[AppSettingsGroup.SystemCommon].boostProcessPriority !==
						prevAppSettings[AppSettingsGroup.SystemCommon].boostProcessPriority))
		) {
			hasInitBoostProcessPriority.current = true;

			setProcessPriority(
				appSettings[AppSettingsGroup.SystemCommon].boostProcessPriority,
			);
		}

		if (
			!hasInitHotLoadPage.current ||
			(prevAppSettings &&
				appSettings[AppSettingsGroup.SystemCore].hotLoadPageCount !==
					prevAppSettings[AppSettingsGroup.SystemCore].hotLoadPageCount)
		) {
			hasInitHotLoadPage.current = true;

			hotLoadPageInit(
				appSettings[AppSettingsGroup.SystemCore].hotLoadPageCount,
			);
		}
	}, [
		appSettings,
		clearCaptureHistory,
		pluginConfigRef,
		isReadyStatus,
		prevAppSettings,
		currentPlatform,
	]);

	useAppSettingsLoad(
		useCallback((appSettings, prevAppSettings) => {
			setAppSettings(appSettings);
			setPrevAppSettings(prevAppSettings);
		}, []),
		true,
	);

	const inited = useRef(false);

	useEffect(() => {
		if (inited.current) {
			return;
		}
		inited.current = true;

		initUiElements();
	}, []);

	useEffect(() => {
		initServices();
	}, [initServices]);

	const hasInitVideoRecord = useRef(false);
	useEffect(() => {
		if (hasInitVideoRecord.current) {
			return;
		}

		if (isReadyStatus?.(PLUGIN_ID_FFMPEG)) {
			hasInitVideoRecord.current = true;

			if (pluginConfigRef.current) {
				pluginConfigRef.current
					.getPluginDirPath(PLUGIN_ID_FFMPEG)
					.then((ffmpegPluginDir) => {
						videoRecordInit(ffmpegPluginDir);
					});
			} else {
				appWarn("[InitService] pluginConfigRef.current is not set");
			}
		}
	}, [isReadyStatus, pluginConfigRef]);

	return null;
};
