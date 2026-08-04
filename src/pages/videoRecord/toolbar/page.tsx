"use client";

import {
	CloseOutlined,
	CopyOutlined,
	GifOutlined,
	HolderOutlined,
	PauseOutlined,
} from "@ant-design/icons";
import { join as joinPath } from "@tauri-apps/api/path";
import {
	type Window as AppWindow,
	getCurrentWindow,
} from "@tauri-apps/api/window";
import { openPath } from "@tauri-apps/plugin-opener";
import { Button, Flex, Spin, theme } from "antd";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import {
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useIntl } from "react-intl";
import clipboard from "tauri-plugin-clipboard-api";
import {
	closeVideoRecordWindow,
	getMonitorsBoundingBox,
	type MonitorBoundingBox,
} from "@/commands/core";
import { createDir } from "@/commands/file";
import {
	setExcludeFromCapture,
	videoRecordKill,
	videoRecordPause,
	videoRecordResume,
	videoRecordStart,
	videoRecordStop,
} from "@/commands/videoRecord";
import { EventListenerContext } from "@/components/eventListener";
import {
	FolderIcon,
	MicrophoneIcon,
	ResumeRecordIcon,
	StartRecordIcon,
	StopRecordIcon,
} from "@/components/icons";
import { PLUGIN_ID_FFMPEG } from "@/constants/pluginService";
import {
	AppSettingsActionContext,
	AppSettingsPublisher,
} from "@/contexts/appSettingsActionContext";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { changeVideoRecordState } from "@/functions/videoRecord";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { useStateRef } from "@/hooks/useStateRef";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { getButtonIconColorByState } from "@/pages/draw/components/drawToolbar/extra";
import {
	type AppSettingsData,
	AppSettingsGroup,
	VideoFormat,
	VideoMaxSize,
} from "@/types/appSettings";
import type { ElementRect } from "@/types/commands/screenshot";
import {
	generateImageFileName,
	getVideoRecordSaveDirectory,
} from "@/utils/file";
import { appError, appInfo } from "@/utils/log";
import { getPlatformValue } from "@/utils/platform";
import type { VideoRecordWindowInfo } from "@/utils/types";
import { setWindowRect } from "@/utils/window";
import { zIndexs } from "@/utils/zIndex";
import { getVideoRecordParams, VideoRecordState } from "../extra";

dayjs.extend(duration);

const convertVideoMaxSizeToWidthAndHeight = (
	videoMaxSize: VideoMaxSize,
): { width: number; height: number } => {
	let videoMaxWidth = 1920;
	let videoMaxHeight = 1080;
	switch (videoMaxSize) {
		case VideoMaxSize.P2160:
			videoMaxWidth = 3840;
			videoMaxHeight = 2160;
			break;
		case VideoMaxSize.P1440:
			videoMaxWidth = 2560;
			videoMaxHeight = 1440;
			break;
		case VideoMaxSize.P1080:
			videoMaxWidth = 1920;
			videoMaxHeight = 1080;
			break;
		case VideoMaxSize.P720:
			videoMaxWidth = 1280;
			videoMaxHeight = 720;
			break;
		case VideoMaxSize.P480:
			videoMaxWidth = 640;
			videoMaxHeight = 480;
			break;
	}

	return { width: videoMaxWidth, height: videoMaxHeight };
};

export const VideoRecordToolbarPage: React.FC = () => {
	const { token } = theme.useToken();
	const intl = useIntl();

	const selectRectRef = useRef<ElementRect | undefined>(undefined);

	const { addListener, removeListener } = useContext(EventListenerContext);

	const toolbarRef = useRef<HTMLDivElement>(null);
	const durationFormatRef = useRef<HTMLDivElement>(null);
	const [videoRecordState, setVideoRecordState, videoRecordStateRef] =
		useStateRef(VideoRecordState.Idle);

	const initWindowRect = useCallback(
		async (
			appWindow: AppWindow,
			selectRect: ElementRect,
			monitorBounds: MonitorBoundingBox,
		) => {
			const scaleFactor = window.devicePixelRatio;

			const toolbarWidth = (toolbarRef.current?.clientWidth ?? 0) + 3 * 2;
			const toolbarHeight = (toolbarRef.current?.clientHeight ?? 0) + 3 * 2;

			const physicalWidth = Math.round(toolbarWidth * scaleFactor);
			const physicalHeight = Math.round(toolbarHeight * scaleFactor);

			const centerX = (selectRect.max_x - selectRect.min_x - physicalWidth) / 2;

			const limitMaxY = getPlatformValue(
				Math.round(
					monitorBounds.rect.max_y -
						physicalHeight -
						//  任务栏高度 48pt
						(48 + 24) * scaleFactor,
				),
				Math.round(
					monitorBounds.rect.max_y -
						physicalHeight -
						// 任务栏高度大概为 72 pt
						(72 + 32) * scaleFactor,
				),
			);
			const limitMinY = getPlatformValue(
				Math.round(monitorBounds.rect.min_y + physicalHeight),
			);
			const targetBottomY = selectRect.max_y + 24 * scaleFactor;
			const targetTopY = selectRect.min_y - physicalHeight - 24 * scaleFactor;
			let targetY = targetBottomY;
			if (targetBottomY > limitMaxY) {
				if (targetTopY > limitMinY) {
					targetY = targetTopY;
				} else {
					targetY = limitMaxY;
				}
			}

			const targetX = Math.round(selectRect.min_x + centerX);
			targetY = Math.round(targetY);

			await setWindowRect(appWindow, {
				min_x: targetX,
				min_y: targetY,
				max_x: targetX + physicalWidth,
				max_y: targetY + physicalHeight,
			});
		},
		[],
	);

	const init = useCallback(
		async (selectRect: ElementRect) => {
			appInfo("[DIAG] videoRecordToolbar init: start", {
				selectRect,
				state: videoRecordStateRef.current,
			});
			if (videoRecordStateRef.current !== VideoRecordState.Idle) {
				appInfo("[DIAG] videoRecordToolbar init: not idle, skipping");
				return;
			}

			selectRectRef.current = selectRect;

			const appWindow = getCurrentWindow();

			appInfo("[DIAG] videoRecordToolbar init: getting monitorBounds");
			const monitorBounds = await getMonitorsBoundingBox(selectRect, true);
			appInfo("[DIAG] videoRecordToolbar init: monitorBounds done");

			await initWindowRect(appWindow, selectRect, monitorBounds);
			// 初始化两次，防止窗口位置不正确
			await initWindowRect(appWindow, selectRect, monitorBounds);

			appInfo("[DIAG] videoRecordToolbar init: showing window");
			await Promise.all([appWindow.show(), appWindow.setAlwaysOnTop(true)]);
			appInfo("[DIAG] videoRecordToolbar init: done");
		},
		[initWindowRect, videoRecordStateRef],
	);

	const dragTitle = useMemo(() => {
		return intl.formatMessage({ id: "draw.drag" });
	}, [intl]);

	const [enableMicrophone, setEnableMicrophone] = useState(false);
	// const [enableSystemAudio, setEnableSystemAudio] = useState(true);
	const durationRef = useRef(0);

	const durationTimer = useRef<NodeJS.Timeout | null>(null);

	const updateDurationFormat = useCallback(() => {
		if (!durationFormatRef.current) {
			appError("[updateDurationFormat] durationFormatRef.current is null");
			return;
		}

		durationFormatRef.current.innerText = dayjs
			.duration(durationRef.current, "seconds")
			.format("HH:mm:ss");
	}, []);

	const stopDurationTimer = useCallback(() => {
		if (durationTimer.current) {
			clearInterval(durationTimer.current);
			durationTimer.current = null;
		}
	}, []);

	const startDurationTimer = useCallback(() => {
		durationTimer.current = setInterval(() => {
			durationRef.current += 0.1;
			updateDurationFormat();
		}, 100);
	}, [updateDurationFormat]);

	useEffect(() => {
		updateDurationFormat();

		return () => {
			if (durationTimer.current) {
				clearInterval(durationTimer.current);
			}
		};
	}, [updateDurationFormat]);

	useEffect(() => {
		changeVideoRecordState(videoRecordState);
	}, [videoRecordState]);

	const [startRecordLoading, setStartRecordLoading] = useState(false);
	const [pauseRecordLoading, setPauseRecordLoading] = useState(false);
	const [resumeRecordLoading, setResumeRecordLoading] = useState(false);
	const [stopRecordLoading, setStopRecordLoading] = useState(false);
	const [settingLoading, setSettingLoading] = useState(true);
	const [openFolderLoading, setOpenFolderLoading] = useState(false);

	const [getAppSettings] = useStateSubscriber(AppSettingsPublisher, undefined);
	const { updateAppSettings } = useContext(AppSettingsActionContext);
	useAppSettingsLoad(
		useCallback((appSettings: AppSettingsData) => {
			setEnableMicrophone(appSettings[AppSettingsGroup.Cache].enableMicrophone);
			setSettingLoading(false);

			setExcludeFromCapture(
				appSettings[AppSettingsGroup.FunctionVideoRecord]
					.enableExcludeFromCapture,
			);
		}, []),
		true,
	);

	const stopRecord = useCallback(
		async (convertToGif: boolean): Promise<string | null | undefined> => {
			setStopRecordLoading(true);

			// 进度改为编码的耗时
			durationRef.current = 0;
			updateDurationFormat();

			let outputFile: string | null | undefined;
			try {
				const { width: gifMaxWidth, height: gifMaxHeight } =
					convertVideoMaxSizeToWidthAndHeight(
						getAppSettings()[AppSettingsGroup.FunctionVideoRecord].gifMaxSize,
					);

				outputFile = await videoRecordStop(
					convertToGif,
					getAppSettings()[AppSettingsGroup.FunctionVideoRecord].gifFormat,
					getAppSettings()[AppSettingsGroup.FunctionVideoRecord].gifFrameRate,
					gifMaxWidth,
					gifMaxHeight,
				);

				setVideoRecordState(VideoRecordState.Idle);

				stopDurationTimer();

				durationRef.current = 0;
				updateDurationFormat();
			} catch {}

			setStopRecordLoading(false);

			return outputFile;
		},
		[
			getAppSettings,
			setVideoRecordState,
			stopDurationTimer,
			updateDurationFormat,
		],
	);

	const enableStopRecord =
		videoRecordState === VideoRecordState.Recording ||
		videoRecordState === VideoRecordState.Paused;

	const onContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
		if (process.env.NODE_ENV === "development") {
			return;
		}

		e.preventDefault();
	}, []);

	const startRecord = useCallback(async () => {
		setStartRecordLoading(true);

		const appSettings = getAppSettings();

		const { width: videoMaxWidth, height: videoMaxHeight } =
			convertVideoMaxSizeToWidthAndHeight(
				appSettings[AppSettingsGroup.FunctionVideoRecord].videoMaxSize,
			);

		videoRecordStart(
			selectRectRef.current?.min_x ?? 0,
			selectRectRef.current?.min_y ?? 0,
			selectRectRef.current?.max_x ?? 0,
			selectRectRef.current?.max_y ?? 0,
			await joinPath(
				await getVideoRecordSaveDirectory(appSettings),
				generateImageFileName(
					appSettings[AppSettingsGroup.FunctionOutput]
						.videoRecordFileNameFormat,
				),
			),
			VideoFormat.Mp4,
			appSettings[AppSettingsGroup.FunctionVideoRecord].frameRate,
			enableMicrophone,
			false,
			appSettings[AppSettingsGroup.FunctionVideoRecord].microphoneDeviceName,
			appSettings[AppSettingsGroup.FunctionVideoRecord].hwaccel,
			appSettings[AppSettingsGroup.FunctionVideoRecord].encoder,
			appSettings[AppSettingsGroup.FunctionVideoRecord].encoderPreset,
			videoMaxWidth,
			videoMaxHeight,
		)
			.then(() => {
				setVideoRecordState(VideoRecordState.Recording);

				stopDurationTimer();

				durationRef.current = 0;
				updateDurationFormat();

				startDurationTimer();
			})
			.finally(() => {
				setStartRecordLoading(false);
			});
	}, [
		setVideoRecordState,
		enableMicrophone,
		getAppSettings,
		stopDurationTimer,
		updateDurationFormat,
		startDurationTimer,
	]);

	const copyVideo = useCallback(
		async (convertToGif: boolean) => {
			stopRecord(convertToGif).then((outputFile) => {
				if (outputFile) {
					clipboard.writeFiles([outputFile]);
				}
			});
		},
		[stopRecord],
	);

	useEffect(() => {
		const startOrCopyVideoListenerId = addListener(
			"start-or-copy-video",
			() => {
				if (videoRecordStateRef.current === VideoRecordState.Idle) {
					startRecord();
				} else {
					copyVideo(false);
				}
			},
		);

		videoRecordKill();

		const closeUnlisten = getCurrentWindow().onCloseRequested(async () => {
			videoRecordKill();
		});

		return () => {
			videoRecordKill();
			removeListener(startOrCopyVideoListenerId);
			closeUnlisten.then((fn) => fn());
		};
	}, [
		addListener,
		removeListener,
		copyVideo,
		startRecord,
		videoRecordStateRef,
	]);

	useEffect(() => {
		const { selectRect } = getVideoRecordParams();

		init(selectRect);

		const listenerId = addListener("reload-video-record", (params) => {
			const windowInfo = (params as { payload: VideoRecordWindowInfo }).payload;

			init({
				min_x: windowInfo.select_rect_min_x,
				min_y: windowInfo.select_rect_min_y,
				max_x: windowInfo.select_rect_max_x,
				max_y: windowInfo.select_rect_max_y,
			});
		});

		return () => {
			removeListener(listenerId);
		};
	}, [addListener, init, removeListener]);

	const { isReadyStatus } = usePluginServiceContext();
	useEffect(() => {
		if (!isReadyStatus) {
			return;
		}

		if (!isReadyStatus(PLUGIN_ID_FFMPEG)) {
			getCurrentWindow().close();
		}
	}, [isReadyStatus]);

	return (
		<div
			className="video-record-toolbar-container"
			onContextMenu={onContextMenu}
		>
			<div data-tauri-drag-region className="toolbar-drag-region before" />
			<div data-tauri-drag-region className="toolbar-drag-region after" />

			<Spin spinning={settingLoading}>
				<div className="video-record-toolbar" ref={toolbarRef}>
					<Flex align="center" gap={token.paddingXS}>
						<div className="drag-button" title={dragTitle}>
							<HolderOutlined />
						</div>

						{videoRecordState === VideoRecordState.Idle && (
							<Button
								loading={startRecordLoading}
								disabled={videoRecordState !== VideoRecordState.Idle}
								onClick={startRecord}
								icon={
									<StartRecordIcon
										style={{
											color: token.colorPrimary,
											position: "relative",
										}}
									/>
								}
								title={intl.formatMessage({ id: "videoRecord.startRecord" })}
								type={"text"}
								key="start-record"
							/>
						)}

						{enableStopRecord && (
							<Button
								loading={stopRecordLoading}
								onClick={() => {
									stopRecord(false);
								}}
								icon={
									<StopRecordIcon
										style={{
											color: token.colorError,
										}}
									/>
								}
								title={intl.formatMessage({ id: "videoRecord.stopRecord" })}
								type={"text"}
								key="stop-record"
							/>
						)}

						{videoRecordState !== VideoRecordState.Paused && (
							<Button
								loading={pauseRecordLoading}
								disabled={videoRecordState !== VideoRecordState.Recording}
								onClick={() => {
									setPauseRecordLoading(true);
									videoRecordPause()
										.then(() => {
											setVideoRecordState(VideoRecordState.Paused);

											stopDurationTimer();
										})
										.finally(() => {
											setPauseRecordLoading(false);
										});
								}}
								icon={
									<PauseOutlined
										style={{
											color:
												videoRecordState === VideoRecordState.Recording
													? token.colorWarning
													: undefined,
										}}
									/>
								}
								title={intl.formatMessage({ id: "videoRecord.pauseRecord" })}
								type={"text"}
								key="pause-record"
							/>
						)}

						{videoRecordState === VideoRecordState.Paused && (
							<Button
								loading={resumeRecordLoading}
								disabled={videoRecordState !== VideoRecordState.Paused}
								onClick={() => {
									setResumeRecordLoading(true);
									videoRecordResume()
										.then(() => {
											setVideoRecordState(VideoRecordState.Recording);

											startDurationTimer();
										})
										.finally(() => {
											setResumeRecordLoading(false);
										});
								}}
								icon={
									<ResumeRecordIcon
										style={{
											color: token.colorPrimary,
										}}
									/>
								}
								title={intl.formatMessage({ id: "videoRecord.resumeRecord" })}
								type={"text"}
								key="resume-record"
							/>
						)}

						<div
							className="video-record-toolbar-time"
							ref={durationFormatRef}
						/>

						<Button
							onClick={() => {
								updateAppSettings(
									AppSettingsGroup.Cache,
									{ enableMicrophone: !enableMicrophone },
									true,
									true,
									false,
									true,
									false,
								);
							}}
							icon={
								<MicrophoneIcon
									style={{
										color: getButtonIconColorByState(enableMicrophone, token),
									}}
								/>
							}
							title={intl.formatMessage({ id: "videoRecord.microphone" })}
							type={"text"}
							key="microphone"
						/>

						{/* <Button
                        onClick={() => {
                            setEnableSystemAudio((prev) => !prev);
                        }}
                        icon={
                            <SystemAudioIcon
                                style={{
                                    color: getButtonIconColorByState(enableSystemAudio, token),
                                }}
                            />
                        }
                        title={intl.formatMessage({ id: 'videoRecord.systemAudio' })}
                        type={'text'}
                        key="system-audio"
                    /> */}

						<div className="video-record-toolbar-splitter" />

						<Button
							loading={openFolderLoading}
							onClick={async () => {
								setOpenFolderLoading(true);
								try {
									const saveDirectory = await getVideoRecordSaveDirectory(
										getAppSettings(),
									);
									await createDir(saveDirectory);
									await openPath(saveDirectory);
								} catch (error) {
									appError("[openFolder] error", error);
								}
								setOpenFolderLoading(false);
							}}
							icon={<FolderIcon style={{}} />}
							title={intl.formatMessage({ id: "videoRecord.openFolder" })}
							type={"text"}
							key="open-folder"
						/>

						<Button
							onClick={() => {
								stopRecord(false).then(() => {
									closeVideoRecordWindow();
								});
							}}
							icon={
								<CloseOutlined
									style={{
										color: token.colorError,
										fontSize: "0.83em",
									}}
								/>
							}
							title={intl.formatMessage({ id: "videoRecord.close" })}
							type={"text"}
							key="close"
						/>

						<Button
							onClick={() => {
								copyVideo(true);
							}}
							icon={
								<GifOutlined
									style={{
										fontSize: "0.96em",
										color: enableStopRecord ? token.colorPrimary : undefined,
									}}
								/>
							}
							disabled={!enableStopRecord}
							title={intl.formatMessage({ id: "videoRecord.copyGif" })}
							type={"text"}
							key="copy-gif"
						/>

						<Button
							onClick={() => {
								copyVideo(false);
							}}
							icon={
								<CopyOutlined
									style={{
										fontSize: "0.88em",
										color: enableStopRecord ? token.colorPrimary : undefined,
									}}
								/>
							}
							disabled={!enableStopRecord}
							title={intl.formatMessage({ id: "videoRecord.copy" })}
							type={"text"}
							key="copy"
						/>

						<div className="drag-button" title={dragTitle}>
							<HolderOutlined />
						</div>
					</Flex>
				</div>
			</Spin>

			<style jsx>{`
                .video-record-toolbar-container {
                    position: fixed;
                    z-index: ${zIndexs.VideoRecord_Toolbar};
                    padding: 3px;
                    user-select: none;
                }

                .toolbar-drag-region {
                    position: absolute;
                    top: 0;
                    width: calc(${token.paddingSM + 3}px + 1em + ${token.paddingXS}px);
                    opacity: 0;
                    height: 100%;
                    background-color: red;
                    z-index: ${zIndexs.VideoRecord_ToolbarDragRegion};
                    cursor: grab;
                }

                .toolbar-drag-region.before {
                    left: 0;
                }

                .toolbar-drag-region.after {
                    right: 0;
                }

                .toolbar-drag-region:active {
                    cursor: grabbing;
                }

                .video-record-toolbar {
                    pointer-events: auto;
                    padding: ${token.paddingXXS}px ${token.paddingSM}px;
                    box-sizing: border-box;
                    background-color: ${token.colorBgContainer};
                    border-radius: ${token.borderRadiusLG}px;
                    cursor: default; /* 防止非拖动区域也变成可拖动状态 */
                    color: ${token.colorText};
                    box-shadow: 0 0 3px 0px ${token.colorPrimaryHover};
                    transition: opacity ${token.motionDurationMid} ${token.motionEaseInOut};
                }

                .drag-button {
                    font-size: 18px;
                    color: ${token.colorTextQuaternary};
                    cursor: grab;
                }

                .video-record-toolbar-time {
                    width: 54px;
                    font-size: 14px;
                    text-align: center;
                    color: ${token.colorTextSecondary};
                }

                .drag-button:active {
                    cursor: grabbing;
                }

                .video-record-toolbar :global(.ant-btn) :global(.ant-btn-icon) {
                    font-size: 24px;
                    display: flex;
                    align-items: center;
                }

                .video-record-toolbar-splitter {
                    width: 1px;
                    height: 0.83em;
                    background-color: ${token.colorBorder};
                    margin: 0 ${token.marginXXS}px;
                }
            `}</style>
		</div>
	);
};
