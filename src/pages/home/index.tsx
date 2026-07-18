import { InfoCircleOutlined } from "@ant-design/icons";
import { Space, Spin, Tooltip, theme } from "antd";
import { useCallback, useContext } from "react";
import { FormattedMessage } from "react-intl";
import { CheckPermissions } from "@/components/checkPermissions";
import { ContentWrap } from "@/components/contentWrap";
import { FunctionButton } from "@/components/functionButton";
import { GlobalShortcutContext } from "@/components/globalShortcut";
import { GroupTitle } from "@/components/groupTitle";
import { KeyButton } from "@/components/keyButton";
import { ResetSettingsButton } from "@/components/resetSettingsButton";
import {
	PLUGIN_ID_AI_CHAT,
	PLUGIN_ID_FFMPEG,
	PLUGIN_ID_RAPID_OCR,
	PLUGIN_ID_TRANSLATE,
} from "@/constants/pluginService";
import { AppSettingsActionContext } from "@/contexts/appSettingsActionContext";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { usePlatform } from "@/hooks/usePlatform";
import {
	type AppSettingsData,
	AppSettingsGroup,
	ShortcutKeyStatus,
} from "@/types/appSettings";
import {
	AppFunction,
	type AppFunctionConfig,
	AppFunctionGroup,
} from "@/types/components/appFunction";
import {
	convertShortcutKeyStatusToButtonColor,
	convertShortcutKeyStatusToTip,
} from "./extra";

export const HomePage = () => {
	const { token } = theme.useToken();

	const { updateAppSettings } = useContext(AppSettingsActionContext);

	const resetFliter = useCallback((group: AppFunctionGroup) => {
		return (settings: Record<string, unknown>) => {
			const newSettings: Partial<
				AppSettingsData[AppSettingsGroup.AppFunction]
			> = {};

			Object.keys(settings).forEach((key) => {
				if ((settings[key] as AppFunctionConfig).group !== group) {
					return;
				}

				newSettings[key as AppFunction] = settings[key] as AppFunctionConfig;
			});

			return newSettings;
		};
	}, []);

	const [currentPlatform] = usePlatform();

	const {
		defaultAppFunctionComponentGroupConfigs,
		updateShortcutKeyStatusLoading,
		appSettingsLoading,
		appFunctionSettings,
		shortcutKeyStatus,
		disableShortcutKeyRef,
	} = useContext(GlobalShortcutContext);

	const { isReadyStatus } = usePluginServiceContext();
	return (
		<ContentWrap className="home-wrap">
			<CheckPermissions />

			{Object.keys(defaultAppFunctionComponentGroupConfigs)
				.filter((group) => {
					if (group === AppFunctionGroup.VideoRecord) {
						return isReadyStatus?.(PLUGIN_ID_FFMPEG);
					}

					if (group === AppFunctionGroup.Chat) {
						return isReadyStatus?.(PLUGIN_ID_AI_CHAT);
					}

					if (group === AppFunctionGroup.Translation) {
						return isReadyStatus?.(PLUGIN_ID_TRANSLATE);
					}

					return true;
				})
				.map((group) => {
					const configs =
						defaultAppFunctionComponentGroupConfigs[group as AppFunctionGroup];

					let groupTitle: React.ReactNode;
					switch (group) {
						case AppFunctionGroup.Screenshot:
							groupTitle = (
								<GroupTitle
									id="screenshotFunction"
									extra={
										<ResetSettingsButton
											title={
												<FormattedMessage
													id="home.screenshotFunction"
													key="screenshotFunction"
												/>
											}
											appSettingsGroup={AppSettingsGroup.AppFunction}
											filter={resetFliter(AppFunctionGroup.Screenshot)}
										/>
									}
								>
									<FormattedMessage
										id="home.screenshotFunction"
										key="screenshotFunction"
									/>
								</GroupTitle>
							);
							break;
						case AppFunctionGroup.Translation:
							groupTitle = (
								<GroupTitle
									id="translationFunction"
									extra={
										<ResetSettingsButton
											title={<FormattedMessage id="home.translationFunction" />}
											appSettingsGroup={AppSettingsGroup.AppFunction}
											filter={resetFliter(AppFunctionGroup.Translation)}
										/>
									}
								>
									<FormattedMessage
										id="home.translationFunction"
										key="translationFunction"
									/>
								</GroupTitle>
							);
							break;
						case AppFunctionGroup.Chat:
							groupTitle = (
								<GroupTitle
									id="chatFunction"
									extra={
										<ResetSettingsButton
											title={<FormattedMessage id="home.chatFunction" />}
											appSettingsGroup={AppSettingsGroup.AppFunction}
											filter={resetFliter(AppFunctionGroup.Chat)}
										/>
									}
								>
									<FormattedMessage id="home.chatFunction" key="chatFunction" />
								</GroupTitle>
							);
							break;
						case AppFunctionGroup.Other:
							groupTitle = (
								<GroupTitle
									id="otherFunction"
									extra={
										<ResetSettingsButton
											title={<FormattedMessage id="home.otherFunction" />}
											appSettingsGroup={AppSettingsGroup.AppFunction}
											filter={resetFliter(AppFunctionGroup.Other)}
										/>
									}
								>
									<FormattedMessage
										id="home.otherFunction"
										key="otherFunction"
									/>
								</GroupTitle>
							);
							break;
						case AppFunctionGroup.VideoRecord:
							groupTitle = (
								<GroupTitle
									id="videoRecordFunction"
									extra={
										<ResetSettingsButton
											title={<FormattedMessage id="home.videoRecordFunction" />}
											appSettingsGroup={AppSettingsGroup.AppFunction}
											filter={resetFliter(AppFunctionGroup.VideoRecord)}
										/>
									}
								>
									<FormattedMessage
										id="home.videoRecordFunction"
										key="videoRecordFunction"
									/>
								</GroupTitle>
							);
							break;
					}

					let speicalKeys: string[] | undefined;
					switch (group) {
						case AppFunctionGroup.Screenshot:
						case AppFunctionGroup.Translation:
						case AppFunctionGroup.Chat:
						case AppFunctionGroup.Other:
							speicalKeys = ["Escape", "PrintScreen"];
							break;
					}

					return (
						<div key={`${group}`} style={{ marginBottom: token.marginLG }}>
							{groupTitle}
							<Spin
								key={`${group}`}
								spinning={updateShortcutKeyStatusLoading || appSettingsLoading}
							>
							<Space
								orientation="vertical"
								size="middle"
								style={{ display: "flex" }}
							>
									{configs
										.filter((config) => {
											if (
												currentPlatform === "macos" &&
												config.configKey === AppFunction.TopWindow
											) {
												return false;
											}

											if (
												config.configKey === AppFunction.ScreenshotOcr ||
												config.configKey === AppFunction.ScreenshotOcrTranslate
											) {
												return isReadyStatus?.(PLUGIN_ID_RAPID_OCR);
											}

											return true;
										})
										.map((config) => {
											const key = config.configKey;
											const currentShortcutKey =
												appFunctionSettings?.[key as AppFunction]?.shortcutKey;
											const statusColor = appSettingsLoading
												? undefined
												: convertShortcutKeyStatusToButtonColor(
														shortcutKeyStatus?.[key as AppFunction],
													);

											const statusTip = appSettingsLoading
												? undefined
												: convertShortcutKeyStatusToTip(
														shortcutKeyStatus?.[key as AppFunction],
													);

											let children: React.ReactNode;
											if (
												shortcutKeyStatus?.[key as AppFunction] ===
												ShortcutKeyStatus.None
											) {
												children = (
													<div
														style={{
															color: token.colorTextDescription,
														}}
													>
														<FormattedMessage id="home.shortcut.none" />
													</div>
												);
											} else if (statusTip) {
												children = (
													<Tooltip
														title={convertShortcutKeyStatusToTip(
															shortcutKeyStatus?.[key as AppFunction],
														)}
													>
														<InfoCircleOutlined />
													</Tooltip>
												);
											}

											return (
												<div key={`${group}-${key}`}>
													<FunctionButton
														label={config.title}
														icon={config.icon}
														onClick={config.onClick}
													>
														<KeyButton
															speicalKeys={speicalKeys}
															title={config.title}
															maxWidth={200}
															keyValue={currentShortcutKey ?? ""}
															buttonProps={{
																variant: "dashed",
																color: statusColor,
																children,
																onClick: () => {
																	disableShortcutKeyRef.current = true;
																},
															}}
															onCancel={() => {
																disableShortcutKeyRef.current = false;
															}}
															onKeyChange={async (value) => {
																disableShortcutKeyRef.current = false;
																updateAppSettings(
																	AppSettingsGroup.AppFunction,
																	{
																		[key as AppFunction]: {
																			...appFunctionSettings?.[
																				key as AppFunction
																			],
																			shortcutKey: value,
																		},
																	},
																	false,
																	true,
																	false,
																	false,
																);
															}}
															maxLength={5}
														/>
													</FunctionButton>
												</div>
											);
										})}
								</Space>
							</Spin>
						</div>
					);
				})}
		</ContentWrap>
	);
};
