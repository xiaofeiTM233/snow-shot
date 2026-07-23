"use client";

import {
	ProForm,
	ProFormDigit,
	ProFormSelect,
	ProFormSlider,
	ProFormSwitch,
} from "@ant-design/pro-components";
import { appLogDir } from "@tauri-apps/api/path";
import * as dialog from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import {
	Button,
	Col,
	Divider,
	Form,
	Row,
	type SelectProps,
	Slider,
	Space,
	Spin,
	Switch,
	Typography,
	theme,
} from "antd";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { restartWithAdmin, setRememberWindowGeometry } from "@/commands/core";
import { createLocalConfigDir, getAppConfigBaseDir } from "@/commands/file";
import { ContentWrap } from "@/components/contentWrap";
import { GroupTitle } from "@/components/groupTitle";
import { IconLabel } from "@/components/iconLable";
import { ResetSettingsButton } from "@/components/resetSettingsButton";
import { PLUGIN_ID_RAPID_OCR } from "@/constants/pluginService";
import { AntdContext } from "@/contexts/antdContext";
import { AppSettingsActionContext } from "@/contexts/appSettingsActionContext";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { usePlatform } from "@/hooks/usePlatform";
import { useStateRef } from "@/hooks/useStateRef";
import {
	type AppSettingsData,
	AppSettingsGroup,
	HdrColorAlgorithm,
	HistoryValidDuration,
	RunLogLevel,
} from "@/types/appSettings";
import { clearAllConfig } from "@/utils/appConfig";
import { clearAllAppStore } from "@/utils/appStore";
import { CaptureHistory } from "@/utils/captureHistory";
import { getConfigDirPath, isAdminWithCache } from "@/utils/environment";
import { appError } from "@/utils/log";
import { MacOSPermissionsSettings } from "./components/macosPermissionsSettings";

export const SystemSettingsPage = () => {
	const intl = useIntl();
	const { token } = theme.useToken();
	const { modal, message } = useContext(AntdContext);

	const { updateAppSettings } = useContext(AppSettingsActionContext);
	const [commonForm] =
		Form.useForm<AppSettingsData[AppSettingsGroup.SystemCommon]>();
	const [coreForm] =
		Form.useForm<AppSettingsData[AppSettingsGroup.SystemCore]>();
	// const [renderForm] = Form.useForm<AppSettingsData[AppSettingsGroup.Render]>();
	const [scrollScreenshotForm] =
		Form.useForm<AppSettingsData[AppSettingsGroup.SystemScrollScreenshot]>();
	const [chatForm] =
		Form.useForm<AppSettingsData[AppSettingsGroup.SystemChat]>();
	const [networkForm] =
		Form.useForm<AppSettingsData[AppSettingsGroup.SystemNetwork]>();
	const [screenshotForm] =
		Form.useForm<AppSettingsData[AppSettingsGroup.SystemScreenshot]>();

	const [appSettingsLoading, setAppSettingsLoading] = useState(true);
	useAppSettingsLoad(
		useCallback(
			(settings: AppSettingsData, preSettings?: AppSettingsData) => {
				setAppSettingsLoading(false);

				// if (
				//     preSettings === undefined ||
				//     preSettings[AppSettingsGroup.Render] !== settings[AppSettingsGroup.Render]
				// ) {
				//     renderForm.setFieldsValue(settings[AppSettingsGroup.Render]);
				// }

				if (
					preSettings === undefined ||
					preSettings[AppSettingsGroup.SystemCommon] !==
						settings[AppSettingsGroup.SystemCommon]
				) {
					commonForm.setFieldsValue(settings[AppSettingsGroup.SystemCommon]);
					// 同步「记住窗口位置大小」开关到 Rust
					setRememberWindowGeometry(
						settings[AppSettingsGroup.SystemCommon].rememberWindowGeometry,
					);
				}

				if (
					preSettings === undefined ||
					preSettings[AppSettingsGroup.SystemChat] !==
						settings[AppSettingsGroup.SystemChat]
				) {
					chatForm.setFieldsValue(settings[AppSettingsGroup.SystemChat]);
				}

				if (
					preSettings === undefined ||
					preSettings[AppSettingsGroup.SystemNetwork] !==
						settings[AppSettingsGroup.SystemNetwork]
				) {
					networkForm.setFieldsValue(settings[AppSettingsGroup.SystemNetwork]);
				}

				if (
					preSettings === undefined ||
					preSettings[AppSettingsGroup.SystemScrollScreenshot] !==
						settings[AppSettingsGroup.SystemScrollScreenshot]
				) {
					scrollScreenshotForm.setFieldsValue(
						settings[AppSettingsGroup.SystemScrollScreenshot],
					);
				}

				if (
					preSettings === undefined ||
					preSettings[AppSettingsGroup.SystemScreenshot] !==
						settings[AppSettingsGroup.SystemScreenshot]
				) {
					screenshotForm.setFieldsValue(
						settings[AppSettingsGroup.SystemScreenshot],
					);
				}

				if (
					preSettings === undefined ||
					preSettings[AppSettingsGroup.SystemCore] !==
						settings[AppSettingsGroup.SystemCore]
				) {
					coreForm.setFieldsValue(settings[AppSettingsGroup.SystemCore]);
				}
			},
			[
				commonForm,
				chatForm,
				networkForm,
				scrollScreenshotForm,
				screenshotForm,
				coreForm,
			],
		),
		true,
	);

	const [configDirPath, setConfigDirPath] = useState<string>("");
	const [configDirBasePath, setConfigDirBasePath] = useState<string>("");
	const [appLogPath, setAppLogPath] = useState<string>("");
	useEffect(() => {
		getConfigDirPath().then((path) => {
			setConfigDirPath(path);
		});
		appLogDir().then((path) => {
			setAppLogPath(path);
		});
		getAppConfigBaseDir().then((path) => {
			setConfigDirBasePath(path);
		});
	}, []);

	const historyValidDurationOptions = useMemo(() => {
		const options = [
			{
				label: intl.formatMessage({
					id: "settings.systemSettings.screenshotSettings.historyValidDuration.day",
				}),
				value: HistoryValidDuration.Day,
			},
			{
				label: intl.formatMessage({
					id: "settings.systemSettings.screenshotSettings.historyValidDuration.three",
				}),
				value: HistoryValidDuration.Three,
			},
			{
				label: intl.formatMessage({
					id: "settings.systemSettings.screenshotSettings.historyValidDuration.week",
				}),
				value: HistoryValidDuration.Week,
			},
			{
				label: intl.formatMessage({
					id: "settings.systemSettings.screenshotSettings.historyValidDuration.month",
				}),
				value: HistoryValidDuration.Month,
			},
			{
				label: intl.formatMessage({
					id: "settings.systemSettings.screenshotSettings.historyValidDuration.forever",
				}),
				value: HistoryValidDuration.Forever,
			},
		];

		if (process.env.NODE_ENV === "development") {
			options.push({
				label: intl.formatMessage({
					id: "settings.systemSettings.screenshotSettings.historyValidDuration.test",
				}),
				value: HistoryValidDuration.Test,
			});
		}

		return options;
	}, [intl]);

	const hdrColorAlgorithmOptions = useMemo((): SelectProps["options"] => {
		return [
			{
				label: (
					<IconLabel
						title={intl.formatMessage({
							id: "settings.systemSettings.screenshotSettings.enableCorrectHdrColor.algorithm.linear",
						})}
						label={
							<FormattedMessage id="settings.systemSettings.screenshotSettings.enableCorrectHdrColor.algorithm.linear" />
						}
						tooltipTitle={
							<FormattedMessage id="settings.systemSettings.screenshotSettings.enableCorrectHdrColor.algorithm.linear.tip" />
						}
					/>
				),
				value: HdrColorAlgorithm.Linear,
			},
		];
	}, [intl]);

	const runLogLevelOptions = useMemo((): SelectProps["options"] => {
		return [
			{
				label: "Off",
				value: RunLogLevel.Off,
			},
			{
				label: "Error",
				value: RunLogLevel.Error,
			},
			{
				label: "Warn",
				value: RunLogLevel.Warn,
			},
			{
				label: "Info",
				value: RunLogLevel.Info,
			},
			{
				label: "Debug",
				value: RunLogLevel.Debug,
			},
			{
				label: "Trace",
				value: RunLogLevel.Trace,
			},
		];
	}, []);

	const [currentPlatform] = usePlatform();

	const [isAdmin, setIsAdmin] = useStateRef<boolean>(false);
	useEffect(() => {
		isAdminWithCache().then((result) => {
			setIsAdmin(result);
		});
	}, [setIsAdmin]);

	const { isReadyStatus } = usePluginServiceContext();

	return (
		<ContentWrap>
			<GroupTitle
				id="commonSettings"
				extra={
					<ResetSettingsButton
						title={
							<FormattedMessage id="settings.systemSettings.commonSettings" />
						}
						appSettingsGroup={AppSettingsGroup.SystemCommon}
					/>
				}
			>
				<FormattedMessage id="settings.systemSettings.commonSettings" />
			</GroupTitle>

			<Spin spinning={appSettingsLoading}>
				<ProForm
					form={commonForm}
					onValuesChange={(_, values) => {
						updateAppSettings(
							AppSettingsGroup.SystemCommon,
							values,
							true,
							true,
							false,
							true,
						);
					}}
					submitter={false}
					layout="horizontal"
				>
					<Row gutter={token.marginLG}>
						<Col span={12}>
							<ProForm.Item
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.commonSettings.autoStart" />
										}
									/>
								}
								name="autoStart"
								valuePropName="checked"
							>
								<Switch />
							</ProForm.Item>
						</Col>
						<Col span={12}>
							<ProForm.Item
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.commonSettings.autoCheckVersion" />
										}
									/>
								}
								name="autoCheckVersion"
								valuePropName="checked"
							>
								<Switch />
							</ProForm.Item>
						</Col>
						<Col span={12}>
							<ProFormSelect
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.commonSettings.runLog" />
										}
									/>
								}
								name="runLog"
								options={runLogLevelOptions}
							/>
						</Col>
						<Col span={12}>
							<ProForm.Item
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.commonSettings.rememberWindowGeometry" />
										}
									/>
								}
								name="rememberWindowGeometry"
								valuePropName="checked"
							>
								<Switch />
							</ProForm.Item>
						</Col>
						{currentPlatform === "windows" && (
							<>
								<Col span={12}>
									<ProForm.Item
										label={
											<IconLabel
												label={
													<FormattedMessage id="settings.systemSettings.commonSettings.adminPermission" />
												}
												tooltipTitle={
													<FormattedMessage id="settings.systemSettings.commonSettings.adminPermission.tip" />
												}
											/>
										}
									>
										{isAdmin ? (
											<div style={{ color: token.colorSuccess }}>
												<FormattedMessage id="settings.systemSettings.commonSettings.adminPermission.enabled" />
											</div>
										) : (
											<Button
												type="default"
												onClick={() => {
													restartWithAdmin();
												}}
											>
												<FormattedMessage id="settings.systemSettings.commonSettings.adminPermission.useAdminRestart" />
											</Button>
										)}
									</ProForm.Item>
								</Col>
								<Col span={12}>
									<ProFormSwitch
										label={
											<IconLabel
												label={
													<FormattedMessage id="settings.systemSettings.commonSettings.boostProcessPriority" />
												}
												tooltipTitle={
													<FormattedMessage id="settings.systemSettings.commonSettings.boostProcessPriority.tip" />
												}
											/>
										}
										name="boostProcessPriority"
									/>
								</Col>
							</>
						)}
					</Row>
				</ProForm>
			</Spin>

			<Divider />

			{currentPlatform === "macos" && (
				<>
					<MacOSPermissionsSettings />

					<Divider />
				</>
			)}

			<GroupTitle
				id="screenshotSettings"
				extra={
					<ResetSettingsButton
						title={
							<FormattedMessage id="settings.systemSettings.screenshotSettings" />
						}
						appSettingsGroup={AppSettingsGroup.SystemScreenshot}
					/>
				}
			>
				<FormattedMessage id="settings.systemSettings.screenshotSettings" />
			</GroupTitle>

			<Spin spinning={appSettingsLoading}>
				<ProForm
					form={screenshotForm}
					onValuesChange={(_, values) => {
						updateAppSettings(
							AppSettingsGroup.SystemScreenshot,
							values,
							true,
							true,
							true,
							true,
							false,
						);
					}}
					submitter={false}
					layout="horizontal"
				>
					<Row gutter={token.marginLG}>
						<Col span={12}>
							<ProFormSwitch
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.screenshotSettings.enableMultipleMonitor" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.systemSettings.screenshotSettings.enableMultipleMonitor.tip" />
										}
									/>
								}
								name="enableMultipleMonitor"
								valuePropName="checked"
							/>
						</Col>

						{currentPlatform === "windows" && (
							<>
								<Col span={12}>
									<ProFormSwitch
										label={
											<IconLabel
												label={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.tryWriteBitmapImageToClipboard" />
												}
												tooltipTitle={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.tryWriteBitmapImageToClipboard.tip" />
												}
											/>
										}
										name="tryWriteBitmapImageToClipboard"
										valuePropName="checked"
									/>
								</Col>

								<Col span={24}>
									<ProFormSwitch
										label={
											<IconLabel
												label={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.correctColorFilter" />
												}
												tooltipTitle={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.correctColorFilter.tip" />
												}
											/>
										}
										name="correctColorFilter"
										valuePropName="checked"
									/>
								</Col>

								<Col span={12}>
									<ProFormSwitch
										label={
											<IconLabel
												label={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.enableCorrectHdrColor" />
												}
												tooltipTitle={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.enableCorrectHdrColor.tip" />
												}
											/>
										}
										name="correctHdrColor"
										valuePropName="checked"
									/>
								</Col>

								<Col span={12}>
									<ProFormSelect
										label={
											<IconLabel
												label={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.enableCorrectHdrColor.algorithm" />
												}
											/>
										}
										name="correctHdrColorAlgorithm"
										options={hdrColorAlgorithmOptions}
									/>
								</Col>
							</>
						)}

						<Col span={12}>
							<ProFormSwitch
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.screenshotSettings.recordCaptureHistory" />
										}
									/>
								}
								name="recordCaptureHistory"
								valuePropName="checked"
							/>
						</Col>
						<Col span={12}>
							<ProFormSelect
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.screenshotSettings.historyValidDuration" />
										}
									/>
								}
								name="historyValidDuration"
								options={historyValidDurationOptions}
							/>
						</Col>
						<Col span={12}>
							<ProFormSwitch
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.screenshotSettings.historySaveEditResult" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.systemSettings.screenshotSettings.historySaveEditResult.tip" />
										}
									/>
								}
								name="historySaveEditResult"
								valuePropName="checked"
							/>
						</Col>

						{isReadyStatus?.(PLUGIN_ID_RAPID_OCR) && (
							<>
								<Col span={12}>
									<ProFormSwitch
										label={
											<IconLabel
												label={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.ocrHotStart" />
												}
												tooltipTitle={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.ocrHotStart.tip" />
												}
											/>
										}
										name="ocrHotStart"
										valuePropName="checked"
									/>
								</Col>

								<Col span={12}>
									<ProFormSwitch
										label={
											<IconLabel
												label={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.ocrModelWriteToMemory" />
												}
												tooltipTitle={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.ocrModelWriteToMemory.tip" />
												}
											/>
										}
										name="ocrModelWriteToMemory"
										valuePropName="checked"
									/>
								</Col>

								<Col span={12}>
									<ProFormSwitch
										label={
											<IconLabel
												label={
													<FormattedMessage id="settings.systemSettings.screenshotSettings.ocrDetectAngle" />
												}
											/>
										}
										name="ocrDetectAngle"
										valuePropName="checked"
									/>
								</Col>
							</>
						)}
					</Row>
				</ProForm>
			</Spin>

			<Divider />

			{/* <GroupTitle
                id="renderSettings"
                extra={
                    <ResetSettingsButton
                        title={
                            <FormattedMessage id="settings.renderSettings" key="renderSettings" />
                        }
                        appSettingsGroup={AppSettingsGroup.Render}
                    />
                }
            >
                <FormattedMessage id="settings.renderSettings" />
            </GroupTitle>

            <Spin spinning={appSettingsLoading}>
                <ProForm
                    form={renderForm}
                    onValuesChange={(_, values) => {
                        updateAppSettings(AppSettingsGroup.Render, values, true, true, true);
                    }}
                    submitter={false}
                    layout="horizontal"
                >
                    <ProForm.Item
                        label={<IconLabel label={<FormattedMessage id="settings.antialias" />} />}
                        name="antialias"
                        valuePropName="checked"
                    >
                        <Switch />
                    </ProForm.Item>
                </ProForm>
            </Spin>

            <Divider /> */}

			<GroupTitle
				id="networkSettings"
				extra={
					<ResetSettingsButton
						title={
							<FormattedMessage id="settings.systemSettings.networkSettings" />
						}
						appSettingsGroup={AppSettingsGroup.SystemNetwork}
					/>
				}
			>
				<FormattedMessage id="settings.systemSettings.networkSettings" />
			</GroupTitle>

			<Spin spinning={appSettingsLoading}>
				<ProForm
					form={networkForm}
					onValuesChange={(_, values) => {
						updateAppSettings(
							AppSettingsGroup.SystemNetwork,
							values,
							true,
							true,
							false,
							true,
						);
					}}
					submitter={false}
					layout="horizontal"
				>
					<ProForm.Item
						label={
							<IconLabel
								label={
									<FormattedMessage id="settings.systemSettings.networkSettings.proxy" />
								}
							/>
						}
						name="enableProxy"
						valuePropName="checked"
					>
						<Switch />
					</ProForm.Item>
				</ProForm>
			</Spin>

			<Divider />

			<GroupTitle
				id="scrollScreenshotSettings"
				extra={
					<ResetSettingsButton
						title={
							<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings" />
						}
						appSettingsGroup={AppSettingsGroup.SystemScrollScreenshot}
					/>
				}
			>
				<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings" />
			</GroupTitle>

			<Spin spinning={appSettingsLoading}>
				<ProForm
					form={scrollScreenshotForm}
					onValuesChange={(_, values) => {
						updateAppSettings(
							AppSettingsGroup.SystemScrollScreenshot,
							values,
							true,
							true,
							true,
							true,
						);
					}}
					submitter={false}
					layout="vertical"
				>
					<Row gutter={token.marginLG}>
						<Col span={12}>
							<ProFormSlider
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.imageFeatureThreshold" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.imageFeatureThreshold.tip" />
										}
									/>
								}
								name="imageFeatureThreshold"
								min={0}
								max={255}
								step={1}
								marks={{
									0: "0",
									255: "255",
								}}
								layout="vertical"
							/>
						</Col>
						<Col span={12}>
							<ProFormSlider
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.sampleRate" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.sampleRate.tip" />
										}
									/>
								}
								name="sampleRate"
								min={0}
								max={1}
								step={0.1}
								marks={{
									0: "0.1",
									1: "1",
								}}
								layout="vertical"
							/>
						</Col>
						<Col span={12}>
							<ProFormSlider
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.minSide" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.minSide.tip" />
										}
									/>
								}
								name="minSide"
								min={64}
								max={1024}
								step={1}
								marks={{
									64: "64",
									1024: "1024",
								}}
								layout="vertical"
							/>
						</Col>
						<Col span={12}>
							<ProFormSlider
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.maxSide" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.maxSide.tip" />
										}
									/>
								}
								name="maxSide"
								min={64}
								max={1024}
								step={1}
								marks={{
									64: "64",
									1024: "1024",
								}}
								layout="vertical"
							/>
						</Col>
						<Col span={12}>
							<ProFormSlider
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.imageFeatureDescriptionLength" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.imageFeatureDescriptionLength.tip" />
										}
									/>
								}
								name="imageFeatureDescriptionLength"
								min={8}
								max={128}
								step={1}
								marks={{
									8: "8",
									128: "128",
								}}
								layout="vertical"
							/>
						</Col>
						<Col span={12}>
							<ProFormSwitch
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.tryRollback" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.systemSettings.scrollScreenshotSettings.tryRollback.tip" />
										}
									/>
								}
								name="tryRollback"
							/>
						</Col>
					</Row>
				</ProForm>
			</Spin>

			<Divider />

			<GroupTitle
				id="chatSettings"
				extra={
					<ResetSettingsButton
						title={
							<FormattedMessage id="settings.chatSettings" key="chatSettings" />
						}
						appSettingsGroup={AppSettingsGroup.SystemChat}
					/>
				}
			>
				<FormattedMessage id="settings.chatSettings" />
			</GroupTitle>

			<Spin spinning={appSettingsLoading}>
				<ProForm
					form={chatForm}
					onValuesChange={(_, values) => {
						updateAppSettings(
							AppSettingsGroup.SystemChat,
							values,
							true,
							true,
							false,
							true,
						);
					}}
					submitter={false}
				>
					<ProForm.Item
						key="maxTokens"
						label={
							<IconLabel
								label={
									<FormattedMessage id="settings.chatSettings.maxTokens" />
								}
								tooltipTitle={
									<FormattedMessage id="settings.chatSettings.maxTokens.tip" />
								}
							/>
						}
						name="maxTokens"
					>
						<Slider
							min={512}
							max={8192}
							step={128}
							marks={{
								512: "512",
								4096: "4096",
								8192: "8192",
							}}
						/>
					</ProForm.Item>

					<ProFormSlider
						key="temperature"
						label={
							<IconLabel
								label={
									<FormattedMessage id="settings.chatSettings.temperature" />
								}
								tooltipTitle={
									<FormattedMessage id="settings.chatSettings.temperature.tip" />
								}
							/>
						}
						name="temperature"
						min={0}
						max={2}
						step={0.1}
						marks={{
							0: "0",
							1: "1",
							2: "2",
						}}
					/>

					<ProFormSlider
						key="thinkingBudgetTokens"
						label={
							<IconLabel
								label={
									<FormattedMessage id="settings.chatSettings.thinkingBudgetTokens" />
								}
								tooltipTitle={
									<FormattedMessage id="settings.chatSettings.thinkingBudgetTokens.tip" />
								}
							/>
						}
						name="thinkingBudgetTokens"
						min={1024}
						max={8192}
						step={128}
						marks={{
							1024: "1024",
							4096: "4096",
							8192: "8192",
						}}
					/>
				</ProForm>
			</Spin>

			<Divider />

			<GroupTitle
				id="coreSettings"
				extra={
					<ResetSettingsButton
						title={
							<FormattedMessage
								key="coreSettings"
								id="settings.systemSettings.coreSettings"
							/>
						}
						appSettingsGroup={AppSettingsGroup.SystemCore}
					/>
				}
			>
				<FormattedMessage id="settings.systemSettings.coreSettings" />
			</GroupTitle>

			<Spin spinning={appSettingsLoading}>
				<ProForm
					form={coreForm}
					onValuesChange={(_, values) => {
						updateAppSettings(
							AppSettingsGroup.SystemCore,
							values,
							true,
							true,
							false,
							true,
						);
					}}
					submitter={false}
					layout="horizontal"
				>
					<Row gutter={token.marginLG}>
						<Col span={12}>
							<ProFormDigit
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.coreSettings.hotLoadPageCount" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.systemSettings.coreSettings.hotLoadPageCount.tip" />
										}
									/>
								}
								name="hotLoadPageCount"
								min={0}
								max={3}
								fieldProps={{
									precision: 0,
								}}
							/>
						</Col>
					</Row>
				</ProForm>
			</Spin>

			<Divider />

			<GroupTitle id="dataFile">
				<FormattedMessage id="settings.systemSettings.dataFile" />
			</GroupTitle>

			<Spin spinning={!configDirPath}>
				<ProForm submitter={false} layout="horizontal">
					<Row gutter={token.marginLG}>
						<Col span={24}>
							<ProForm.Item
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.dataDirectory" />
										}
									/>
								}
							>
								<Space wrap>
									<Typography.Text
										copyable={{
											text: configDirBasePath,
										}}
									>
										{configDirBasePath}
									</Typography.Text>
									<Button
										color="orange"
										onClick={async () => {
											try {
												const path = await dialog.open({
													directory: true,
													defaultPath: configDirBasePath,
												});
												if (!path) {
													return;
												}

												await createLocalConfigDir(path);
												relaunch();
											} catch (error) {
												appError("[enableLocalConfig] error", error);
												message.error(`${error}`);
											}
										}}
									>
										<IconLabel
											label={
												<FormattedMessage id="settings.systemSettings.dataFilePath.setDirectory" />
											}
											tooltipTitle={
												<FormattedMessage id="settings.systemSettings.dataFilePath.setDirectory.tip" />
											}
										/>
									</Button>
								</Space>
							</ProForm.Item>
						</Col>
						<Col span={24}>
							<ProForm.Item
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.dataFilePath" />
										}
									/>
								}
							>
								<Space wrap>
									<Typography.Text
										copyable={{
											text: configDirPath,
										}}
									>
										{configDirPath}
									</Typography.Text>
									<Button
										onClick={async () => {
											try {
												await openPath(configDirPath);
											} catch {
												message.error(
													<FormattedMessage id="settings.systemSettings.dataFilePath.open.failed" />,
												);
											}
										}}
									>
										<FormattedMessage id="settings.systemSettings.dataFilePath.open" />
									</Button>
								</Space>
							</ProForm.Item>
						</Col>
						<Col span={24}>
							<ProForm.Item
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.appLogFilePath" />
										}
									/>
								}
							>
								<Space wrap>
									<Typography.Text
										copyable={{
											text: appLogPath,
										}}
									>
										{appLogPath}
									</Typography.Text>
									<Button
										onClick={async () => {
											try {
												await openPath(appLogPath);
											} catch {
												message.error(
													<FormattedMessage id="settings.systemSettings.appLogFilePath.open.failed" />,
												);
											}
										}}
									>
										<FormattedMessage id="settings.systemSettings.appLogFilePath.open" />
									</Button>
								</Space>
							</ProForm.Item>
						</Col>
						<Col span={12}>
							<ProForm.Item
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.systemSettings.dataFile.clearAll" />
										}
									/>
								}
							>
								<Button
									type="primary"
									danger
									onClick={() => {
										modal.confirm({
											title: (
												<FormattedMessage id="settings.systemSettings.dataFile.clearAll.confirm" />
											),
											type: "error",
											onOk: async () => {
												await Promise.all([
													clearAllAppStore(),
													clearAllConfig(),
													(async () => {
														const captureHistory = new CaptureHistory();
														await captureHistory.init();
														await captureHistory.clearAll();
													})(),
												]);
												relaunch();
											},
										});
									}}
								>
									<FormattedMessage id="settings.systemSettings.dataFile.clearAll" />
								</Button>
							</ProForm.Item>
						</Col>
					</Row>
				</ProForm>
			</Spin>
		</ContentWrap>
	);
};
