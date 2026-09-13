"use client";

import {
	ProForm,
	ProFormRadio,
	ProFormSlider,
	ProFormSwitch,
} from "@ant-design/pro-components";
import { resourceDir } from "@tauri-apps/api/path";
import {
	type CheckboxOptionType,
	Col,
	ColorPicker,
	Divider,
	Form,
	Image,
	Row,
	Select,
	Space,
	Spin,
	theme,
} from "antd";
import type { AggregationColor } from "antd/es/color-picker/color";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ContentWrap } from "@/components/contentWrap";
import { GroupTitle, SubGroupTitle } from "@/components/groupTitle";
import { IconLabel } from "@/components/iconLable";
import { DarkModeIcon, LanguageIcon } from "@/components/icons";
import { PathInput } from "@/components/pathInput";
import { ResetSettingsButton } from "@/components/resetSettingsButton";
import { ToolbarCustomizer } from "@/components/toolbarCustomizer";
import { getDefaultIconPath } from "@/components/trayIconLoader";
import { AppSettingsActionContext } from "@/contexts/appSettingsActionContext";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { useStateRef } from "@/hooks/useStateRef";
import {
	AppSettingsControlNode,
	type AppSettingsData,
	AppSettingsGroup,
	AppSettingsLanguage,
	AppSettingsTheme,
	ColorPickerShowMode,
	TrayIconDefaultIcon,
} from "@/types/appSettings";
import { ToolbarId } from "@/types/toolbarTool";

const { Option } = Select;

export const GeneralSettingsPage = () => {
	const intl = useIntl();
	const { token } = theme.useToken();

	const { updateAppSettings } = useContext(AppSettingsActionContext);
	const [commonForm] = Form.useForm<AppSettingsData[AppSettingsGroup.Common]>();
	const [screenshotForm] =
		Form.useForm<AppSettingsData[AppSettingsGroup.Screenshot]>();
	const [colorForm] = Form.useForm<{
		mainColor: string;
		borderColor: string;
	}>();
	const [trayIconForm] =
		Form.useForm<AppSettingsData[AppSettingsGroup.CommonTrayIcon]>();

	const [appSettingsLoading, setAppSettingsLoading] = useStateRef(true);
	useAppSettingsLoad(
		useCallback(
			(settings: AppSettingsData, preSettings?: AppSettingsData) => {
				setAppSettingsLoading(false);
				if (
					preSettings === undefined ||
					preSettings[AppSettingsGroup.Common] !==
						settings[AppSettingsGroup.Common]
				) {
					commonForm.setFieldsValue(settings[AppSettingsGroup.Common]);
				}

				if (
					preSettings === undefined ||
					preSettings[AppSettingsGroup.Screenshot] !==
						settings[AppSettingsGroup.Screenshot]
				) {
					screenshotForm.setFieldsValue(settings[AppSettingsGroup.Screenshot]);
				}

				if (
					preSettings === undefined ||
					preSettings[AppSettingsGroup.CommonTrayIcon] !==
						settings[AppSettingsGroup.CommonTrayIcon]
				) {
					trayIconForm.setFieldsValue(
						settings[AppSettingsGroup.CommonTrayIcon],
					);
				}

				if (
					preSettings === undefined ||
					preSettings[AppSettingsGroup.Common].mainColor !==
						settings[AppSettingsGroup.Common].mainColor ||
					preSettings[AppSettingsGroup.FixedContent].borderColor !==
						settings[AppSettingsGroup.FixedContent].borderColor
				) {
					colorForm.setFieldsValue({
						mainColor: settings[AppSettingsGroup.Common].mainColor,
						borderColor: settings[AppSettingsGroup.FixedContent].borderColor,
					});
				}
			},
			[
				colorForm,
				commonForm,
				screenshotForm,
				setAppSettingsLoading,
				trayIconForm,
			],
		),
		true,
	);

	const [defaultIconsOptions, setDefaultIconsOptions] = useState<
		CheckboxOptionType<TrayIconDefaultIcon>[]
	>([]);
	const initDefaultIconsOptions = useCallback(async () => {
		const appDataDir = await resourceDir();
		const [
			defaultIconPath,
			lightIconPath,
			darkIconPath,
			snowDefaultIconPath,
			snowLightIconPath,
			snowDarkIconPath,
		] = await Promise.all([
			getDefaultIconPath(TrayIconDefaultIcon.Default, appDataDir),
			getDefaultIconPath(TrayIconDefaultIcon.Light, appDataDir),
			getDefaultIconPath(TrayIconDefaultIcon.Dark, appDataDir),
			getDefaultIconPath(TrayIconDefaultIcon.SnowDefault, appDataDir),
			getDefaultIconPath(TrayIconDefaultIcon.SnowLight, appDataDir),
			getDefaultIconPath(TrayIconDefaultIcon.SnowDark, appDataDir),
		]);

		const iconSize = 24;
		setDefaultIconsOptions([
			{
				label: (
					<Space>
						{intl.formatMessage({
							id: "settings.commonSettings.trayIconSettings.defaultIcons.default",
						})}
						<Image
							src={defaultIconPath.web_path}
							width={iconSize}
							height={iconSize}
							alt="default"
						/>
					</Space>
				),
				title: intl.formatMessage({
					id: "settings.commonSettings.trayIconSettings.defaultIcons.default",
				}),
				value: TrayIconDefaultIcon.Default,
			},
			{
				label: (
					<Space>
						{intl.formatMessage({
							id: "settings.commonSettings.trayIconSettings.defaultIcons.light",
						})}
						<Image
							src={lightIconPath.web_path}
							width={iconSize}
							height={iconSize}
							alt="light"
						/>
					</Space>
				),
				title: intl.formatMessage({
					id: "settings.commonSettings.trayIconSettings.defaultIcons.light",
				}),
				value: TrayIconDefaultIcon.Light,
			},
			{
				label: (
					<Space>
						{intl.formatMessage({
							id: "settings.commonSettings.trayIconSettings.defaultIcons.dark",
						})}
						<Image
							src={darkIconPath.web_path}
							width={iconSize}
							height={iconSize}
							alt="dark"
						/>
					</Space>
				),
				title: intl.formatMessage({
					id: "settings.commonSettings.trayIconSettings.defaultIcons.dark",
				}),
				value: TrayIconDefaultIcon.Dark,
			},
			{
				label: (
					<Space>
						{intl.formatMessage({
							id: "settings.commonSettings.trayIconSettings.defaultIcons.snowDefault",
						})}
						<Image
							src={snowDefaultIconPath.web_path}
							width={iconSize}
							height={iconSize}
							alt="snow-default"
						/>
					</Space>
				),
				title: intl.formatMessage({
					id: "settings.commonSettings.trayIconSettings.defaultIcons.snowDefault",
				}),
				value: TrayIconDefaultIcon.SnowDefault,
			},

			{
				label: (
					<Space>
						{intl.formatMessage({
							id: "settings.commonSettings.trayIconSettings.defaultIcons.snowLight",
						})}
						<Image
							src={snowLightIconPath.web_path}
							width={iconSize}
							height={iconSize}
							alt="snow-light"
						/>
					</Space>
				),
				title: intl.formatMessage({
					id: "settings.commonSettings.trayIconSettings.defaultIcons.snowLight",
				}),
				value: TrayIconDefaultIcon.SnowLight,
			},
			{
				label: (
					<Space>
						{intl.formatMessage({
							id: "settings.commonSettings.trayIconSettings.defaultIcons.snowDark",
						})}
						<Image
							src={snowDarkIconPath.web_path}
							width={iconSize}
							height={iconSize}
							alt="snow-dark"
						/>
					</Space>
				),
				title: intl.formatMessage({
					id: "settings.commonSettings.trayIconSettings.defaultIcons.snowDark",
				}),
				value: TrayIconDefaultIcon.SnowDark,
			},
		]);
	}, [intl]);

	const themeOptions = useMemo(() => {
		return [
			{
				label: intl.formatMessage({ id: "settings.theme.light" }),
				value: AppSettingsTheme.Light,
			},
			{
				label: intl.formatMessage({ id: "settings.theme.dark" }),
				value: AppSettingsTheme.Dark,
			},
			{
				label: intl.formatMessage({ id: "settings.theme.system" }),
				value: AppSettingsTheme.System,
			},
		];
	}, [intl]);

	useEffect(() => {
		initDefaultIconsOptions();
	}, [initDefaultIconsOptions]);

	return (
		<ContentWrap className="settings-wrap">
			<GroupTitle
				id="commonSettings"
				extra={
					<ResetSettingsButton
						title={
							<FormattedMessage
								id="settings.commonSettings"
								key="commonSettings"
							/>
						}
						appSettingsGroup={AppSettingsGroup.Common}
					/>
				}
			>
				<FormattedMessage id="settings.commonSettings" />
			</GroupTitle>

			<Form
				className="settings-form common-settings-form"
				form={commonForm}
				onValuesChange={(_, values) => {
					updateAppSettings(AppSettingsGroup.Common, values, true, true, true);
				}}
				layout="vertical"
			>
				<Spin spinning={appSettingsLoading}>
					<Row gutter={token.marginLG}>
						<Col span={12}>
							<Form.Item
								label={
									<IconLabel
										icon={<DarkModeIcon />}
										label={<FormattedMessage id="settings.theme" />}
									/>
								}
								name="theme"
							>
								<Select options={themeOptions} />
							</Form.Item>
						</Col>
						<Col span={12}>
							<Form.Item
								className="settings-wrap-language"
								name="language"
								label={
									<IconLabel
										icon={<LanguageIcon />}
										label={<FormattedMessage id="settings.language" />}
									/>
								}
								required={false}
								rules={[{ required: true }]}
							>
								<Select>
									<Option value={AppSettingsLanguage.EN}>English</Option>
									<Option value={AppSettingsLanguage.ZHHant}>繁體中文</Option>
									<Option value={AppSettingsLanguage.ZHHans}>简体中文</Option>
								</Select>
							</Form.Item>
						</Col>
					</Row>
				</Spin>
			</Form>

			<Divider />

			<GroupTitle
				id="colorSettings"
				extra={
					<ResetSettingsButton
						title={intl.formatMessage({ id: "settings.fixedContentSettings" })}
						appSettingsGroup={AppSettingsGroup.FixedContent}
					/>
				}
			>
				<FormattedMessage id="settings.colorSettings" />
			</GroupTitle>

			<ProForm<{
				mainColor: string;
				borderColor: string;
			}>
				className="settings-form color-settings-form"
				form={colorForm}
				submitter={false}
				onValuesChange={(changedValues) => {
					if (changedValues.mainColor !== undefined) {
						let mainColor = changedValues.mainColor;
						if (typeof mainColor === "object") {
							mainColor = (mainColor as AggregationColor).toHexString();
						}

						updateAppSettings(
							AppSettingsGroup.Common,
							{ mainColor },
							true,
							true,
							true,
						);
					}

					if (changedValues.borderColor !== undefined) {
						let borderColor = changedValues.borderColor;
						if (typeof borderColor === "object") {
							borderColor = (borderColor as AggregationColor).toHexString();
						}

						updateAppSettings(
							AppSettingsGroup.FixedContent,
							{ borderColor },
							true,
							true,
							true,
							true,
							false,
						);
					}
				}}
				layout="vertical"
			>
				<Spin spinning={appSettingsLoading}>
					<Row gutter={token.marginLG}>
						<Col span={12}>
							<ProForm.Item
								name="mainColor"
								label={
									<IconLabel
										label={<FormattedMessage id="settings.theme.mainColor" />}
									/>
								}
								required={false}
							>
								<ColorPicker showText placement="bottom" />
							</ProForm.Item>
						</Col>

						<Col span={12}>
							<ProForm.Item
								name="borderColor"
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.fixedContentSettings.borderColor" />
										}
									/>
								}
								required={false}
							>
								<ColorPicker showText placement="bottom" />
							</ProForm.Item>
						</Col>
					</Row>
				</Spin>
			</ProForm>

			<Divider />

			<GroupTitle
				id="screenshotSettings"
				extra={
					<ResetSettingsButton
						title={intl.formatMessage({ id: "settings.screenshotSettings" })}
						appSettingsGroup={AppSettingsGroup.Screenshot}
					/>
				}
			>
				<FormattedMessage id="settings.screenshotSettings" />
			</GroupTitle>

			<ProForm<AppSettingsData[AppSettingsGroup.Screenshot]>
				className="settings-form screenshot-settings-form"
				form={screenshotForm}
				submitter={false}
				onValuesChange={(_, values) => {
					if (typeof values.fullScreenAuxiliaryLineColor === "object") {
						values.fullScreenAuxiliaryLineColor = (
							values.fullScreenAuxiliaryLineColor as AggregationColor
						).toHexString();
					}

					if (typeof values.monitorCenterAuxiliaryLineColor === "object") {
						values.monitorCenterAuxiliaryLineColor = (
							values.monitorCenterAuxiliaryLineColor as AggregationColor
						).toHexString();
					}

					if (typeof values.colorPickerCenterAuxiliaryLineColor === "object") {
						values.colorPickerCenterAuxiliaryLineColor = (
							values.colorPickerCenterAuxiliaryLineColor as AggregationColor
						).toHexString();
					}

					if (typeof values.selectRectMaskColor === "object") {
						values.selectRectMaskColor = (
							values.selectRectMaskColor as AggregationColor
						).toHexString();
					}

					updateAppSettings(
						AppSettingsGroup.Screenshot,
						values,
						true,
						true,
						true,
						true,
						false,
					);
				}}
				layout="vertical"
			>
				<Spin spinning={appSettingsLoading}>
					<Row gutter={token.marginLG}>
						<Col span={12}>
							<ProFormSlider
								name="uiScale"
								label={
									<FormattedMessage id="settings.commonSettings.screenshotSettings.uiScale" />
								}
								min={25}
								max={100}
								step={1}
								marks={{
									25: "25%",
									100: "100%",
								}}
							/>
						</Col>

						<Col span={12}>
							<ProFormSlider
								name="toolbarUiScale"
								label={
									<FormattedMessage id="settings.commonSettings.screenshotSettings.toolbarUiScale" />
								}
								min={25}
								max={100}
								step={1}
								marks={{
									25: "25%",
									100: "100%",
								}}
							/>
						</Col>

						<Col span={12}>
							<ProForm.Item
								className="settings-wrap-language"
								name="controlNode"
								label={
									<IconLabel
										label={<FormattedMessage id="settings.controlNode" />}
									/>
								}
								required={false}
								rules={[{ required: true }]}
							>
								<Select>
									<Option value={AppSettingsControlNode.Circle}>
										<FormattedMessage id="settings.controlNode.circle" />
									</Option>
								</Select>
							</ProForm.Item>
						</Col>

						<Col span={12}>
							<ProFormSwitch
								name="disableAnimation"
								label={<FormattedMessage id="settings.disableAnimation" />}
							/>
						</Col>
					</Row>

					<Row gutter={token.marginLG}>
						<Col span={24}>
							<ProFormRadio.Group
								name="colorPickerShowMode"
								layout="horizontal"
								label={
									<FormattedMessage id="settings.functionSettings.screenshotSettings.colorPickerShowMode" />
								}
								options={[
									{
										label: (
											<FormattedMessage id="settings.functionSettings.screenshotSettings.beyondSelectRect" />
										),
										value: ColorPickerShowMode.BeyondSelectRect,
									},
									{
										label: (
											<FormattedMessage id="settings.functionSettings.screenshotSettings.alwaysShowColorPicker" />
										),
										value: ColorPickerShowMode.Always,
									},
									{
										label: (
											<FormattedMessage id="settings.functionSettings.screenshotSettings.neverShowColorPicker" />
										),
										value: ColorPickerShowMode.Never,
									},
								]}
							/>
						</Col>
					</Row>

					<Row gutter={token.marginLG}>
						<Col span={12}>
							<ProFormSlider
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.functionSettings.screenshotSettings.beyondSelectRectElementOpacity" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.functionSettings.screenshotSettings.beyondSelectRectElementOpacity.tip" />
										}
									/>
								}
								name="beyondSelectRectElementOpacity"
								min={0}
								max={100}
								step={1}
								marks={{
									0: "0%",
									100: "100%",
								}}
							/>
						</Col>

						<Col span={12}>
							<ProFormSlider
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.functionSettings.screenshotSettings.hotKeyTipOpacity" />
										}
									/>
								}
								name="hotKeyTipOpacity"
								min={0}
								max={100}
								step={1}
								marks={{
									0: "0%",
									100: "100%",
								}}
							/>
						</Col>
					</Row>

					<Row gutter={token.marginLG}>
						<Col span={12}>
							<ProForm.Item
								name="fullScreenAuxiliaryLineColor"
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.fullScreenAuxiliaryLineColor" />
										}
									/>
								}
								required={false}
							>
								<ColorPicker showText placement="bottom" />
							</ProForm.Item>
						</Col>

						<Col span={12}>
							<ProForm.Item
								name="monitorCenterAuxiliaryLineColor"
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.monitorCenterAuxiliaryLineColor" />
										}
									/>
								}
								required={false}
							>
								<ColorPicker showText placement="bottom" />
							</ProForm.Item>
						</Col>

						<Col span={12}>
							<ProForm.Item
								name="colorPickerCenterAuxiliaryLineColor"
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.colorPickerCenterAuxiliaryLineColor" />
										}
									/>
								}
								required={false}
							>
								<ColorPicker showText placement="bottom" />
							</ProForm.Item>
						</Col>

						<Col span={12}>
							<ProForm.Item
								name="selectRectMaskColor"
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.selectRectMaskColor" />
										}
									/>
								}
								required={false}
							>
								<ColorPicker showText placement="bottom" />
							</ProForm.Item>
						</Col>
					</Row>
				</Spin>
			</ProForm>

			<Divider />

			<GroupTitle id="toolbarSettings">
				<FormattedMessage id="settings.toolbarSettings" />
			</GroupTitle>

			<SubGroupTitle>
				<FormattedMessage id="settings.toolbarSettings.mainToolbar" />
			</SubGroupTitle>
			<ToolbarCustomizer toolbarId={ToolbarId.Main} />

			<SubGroupTitle>
				<FormattedMessage id="settings.toolbarSettings.fullScreenDrawToolbar" />
			</SubGroupTitle>
			<ToolbarCustomizer toolbarId={ToolbarId.FullScreen} />

			<SubGroupTitle>
				<FormattedMessage id="settings.toolbarSettings.fixedContentToolbar" />
			</SubGroupTitle>
			<ToolbarCustomizer toolbarId={ToolbarId.FixedContent} />

			<Divider />

			<GroupTitle
				id="trayIconSettings"
				extra={
					<ResetSettingsButton
						title={intl.formatMessage({
							id: "settings.commonSettings.trayIconSettings",
						})}
						appSettingsGroup={AppSettingsGroup.CommonTrayIcon}
					/>
				}
			>
				<FormattedMessage id="settings.commonSettings.trayIconSettings" />
			</GroupTitle>

			<ProForm<AppSettingsData[AppSettingsGroup.CommonTrayIcon]>
				form={trayIconForm}
				submitter={false}
				onValuesChange={(_, values) => {
					updateAppSettings(
						AppSettingsGroup.CommonTrayIcon,
						values,
						true,
						true,
						true,
						true,
						false,
					);
				}}
				layout="horizontal"
			>
				<Spin spinning={appSettingsLoading}>
					<Row gutter={token.marginLG}>
						<Col span={12}>
							<ProFormSwitch
								name="enableTrayIcon"
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.commonSettings.trayIconSettings.enableTrayIcon" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.commonSettings.trayIconSettings.enableTrayIconTip" />
										}
									/>
								}
							/>
						</Col>

						<Col span={24}>
							<ProFormRadio.Group
								name="defaultIcons"
								label={
									<FormattedMessage id="settings.commonSettings.trayIconSettings.defaultIcons" />
								}
								options={defaultIconsOptions}
							/>
						</Col>

						<Col span={24}>
							<ProForm.Item
								name="iconPath"
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.commonSettings.trayIconSettings.iconPath" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.commonSettings.trayIconSettings.iconPath.tip" />
										}
									/>
								}
								required={false}
							>
								<PathInput
									filters={[
										{ name: "PNG(*.png)", extensions: ["png"] },
										{ name: "ICO(*.ico)", extensions: ["ico"] },
									]}
								/>
							</ProForm.Item>
						</Col>

						<Col span={24}>
							<ProFormRadio.Group
								name="defaultIconsDark"
								label={
									<FormattedMessage id="settings.commonSettings.trayIconSettings.defaultIcons.darkDefault" />
								}
								options={defaultIconsOptions}
							/>
						</Col>

						<Col span={24}>
							<ProForm.Item
								name="iconPathDark"
								label={
									<IconLabel
										label={
											<FormattedMessage id="settings.commonSettings.trayIconSettings.iconPath.darkDefault" />
										}
										tooltipTitle={
											<FormattedMessage id="settings.commonSettings.trayIconSettings.iconPath.tip" />
										}
									/>
								}
								required={false}
							>
								<PathInput
									filters={[
										{ name: "PNG(*.png)", extensions: ["png"] },
										{ name: "ICO(*.ico)", extensions: ["ico"] },
									]}
								/>
							</ProForm.Item>
						</Col>
					</Row>
				</Spin>
			</ProForm>

			<style jsx>{`
                :global(.settings-form)
                    :global(.settings-wrap-language)
                    :global(.ant-form-item-control) {
                    flex-grow: unset !important;
                    min-width: 128px;
                }
            `}</style>
		</ContentWrap>
	);
};
