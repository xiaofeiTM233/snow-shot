import { SettingOutlined } from "@ant-design/icons";
import { ModalForm, ProForm } from "@ant-design/pro-components";
import { Button, Col, Row, Select, theme } from "antd";
import type { SelectProps } from "antd";
import { useCallback, useContext, useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { IconLabel } from "@/components/iconLable";
import {
	defaultAppSettingsData,
	ONLINE_OCR_MODEL_PREFIX,
} from "@/constants/appSettings";
import { PLUGIN_ID_AI_CHAT, PLUGIN_ID_RAPID_OCR } from "@/constants/pluginService";
import { AppSettingsActionContext } from "@/contexts/appSettingsActionContext";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { useVisionModelList } from "@/pages/fixedContent/components/ocrResult";
import { TranslationConfig } from "@/pages/settings/functionSettings/components/translationConfig";
import {
	AppSettingsGroup,
	OcrModel,
	type CustomOcrModelConfig,
	type OnlineOcrModelConfig,
} from "@/types/appSettings";

const OCR_SETTINGS_I18N_PREFIX = "settings.functionSettings.ocrSettings";

/** 文本识别模型 / 视觉理解模型配置，选项与 functionSettings 的 OCR 设置保持一致 */
const OcrModelConfig = () => {
	const intl = useIntl();
	const { token } = theme.useToken();
	const { isReadyStatus } = usePluginServiceContext();
	const { updateAppSettings } = useContext(AppSettingsActionContext);
	const { getVisionModelList } = useVisionModelList();

	const [ocrModel, setOcrModel] = useState<string | undefined>(undefined);
	const [ocrModelOptions, setOcrModelOptions] = useState<SelectProps["options"]>(
		[],
	);
	const [htmlVisionModel, setHtmlVisionModel] = useState<string | undefined>(
		undefined,
	);
	const [htmlVisionModelOptions, setHtmlVisionModelOptions] = useState<
		SelectProps["options"]
	>([]);

	// 订阅设置变化：弹窗常驻挂载（forceRender: false），需在设置于其它窗口被修改后保持同步
	useAppSettingsLoad(
		useCallback(
			(settings) => {
				const ocrSettings = settings[AppSettingsGroup.FunctionOcr];
				setOcrModel(ocrSettings.ocrModel);
				setHtmlVisionModel(ocrSettings.htmlVisionModel);

				const localOptions = [
					{
						label: intl.formatMessage({
							id: "settings.systemSettings.screenshotSettings.ocrModel.paddleOcrV4",
						}),
						value: OcrModel.RapidOcrV4,
					},
					...(ocrSettings.customOcrModelConfigList || [])
						.filter((c: CustomOcrModelConfig) => c.model_name)
						.map((c: CustomOcrModelConfig) => ({
							label: c.model_name,
							value: c.model_name,
						})),
				];
				const onlineOptions = (ocrSettings.onlineOcrModelConfigList || [])
					.filter((c: OnlineOcrModelConfig) => c.model_name)
					.map((c: OnlineOcrModelConfig) => ({
						label: c.model_name,
						value: `${ONLINE_OCR_MODEL_PREFIX}${c.model_name}`,
					}));

				// 添加了在线识别时，按【本地识别】/【在线识别】分组展示
				setOcrModelOptions(
					onlineOptions.length > 0
						? [
								{
									label: intl.formatMessage({
										id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.modelGroup.local`,
									}),
									title: intl.formatMessage({
										id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.modelGroup.local`,
									}),
									options: localOptions,
								},
								{
									label: intl.formatMessage({
										id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.modelGroup.online`,
									}),
									title: intl.formatMessage({
										id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.modelGroup.online`,
									}),
									options: onlineOptions,
								},
							]
						: localOptions,
				);

				if (!isReadyStatus?.(PLUGIN_ID_AI_CHAT)) {
					return;
				}
				getVisionModelList().then((visionModelList) => {
					const officialVisionModelList = visionModelList.filter(
						(model) => model.isOfficial,
					);
					const customVisionModelList = visionModelList.filter(
						(model) => !model.isOfficial,
					);

					setHtmlVisionModelOptions([
						{
							label: (
								<IconLabel
									label={intl.formatMessage({
										id: `${OCR_SETTINGS_I18N_PREFIX}.htmlVisionModel.default`,
									})}
									tooltipTitle={intl.formatMessage({
										id: `${OCR_SETTINGS_I18N_PREFIX}.htmlVisionModel.default.tip`,
									})}
								/>
							),
							value:
								defaultAppSettingsData[AppSettingsGroup.FunctionOcr]
									.htmlVisionModel,
						},
						customVisionModelList.length > 0
							? {
									label: <FormattedMessage id="tools.chat.custom" />,
									options: customVisionModelList.map((model) => ({
										label: model.config.model_name,
										value: model.config.model_name,
									})),
								}
							: undefined,
						officialVisionModelList.length > 0
							? {
									label: <FormattedMessage id="tools.chat.official" />,
									options: officialVisionModelList.map((model) => ({
										label: model.config.model_name,
										value: model.config.model_name,
									})),
								}
							: undefined,
					].filter(Boolean) as SelectProps["options"]);
				});
			},
			[getVisionModelList, intl, isReadyStatus],
		),
		true,
	);

	return (
		<Row gutter={token.marginLG}>
			{isReadyStatus?.(PLUGIN_ID_RAPID_OCR) && (
				<Col span={12}>
					<ProForm.Item
						layout="vertical"
						label={
							<FormattedMessage id="settings.systemSettings.screenshotSettings.ocrModel" />
						}
					>
						<Select
							value={ocrModel}
							onChange={(value) => {
								setOcrModel(value);
								updateAppSettings(
									AppSettingsGroup.FunctionOcr,
									{ ocrModel: value },
									true,
									true,
									true,
									true,
									false,
								);
							}}
							options={ocrModelOptions}
						/>
					</ProForm.Item>
				</Col>
			)}
			{isReadyStatus?.(PLUGIN_ID_AI_CHAT) && (
				<Col span={12}>
					<ProForm.Item
						layout="vertical"
						label={
							<IconLabel
								label={
									<FormattedMessage
										id={`${OCR_SETTINGS_I18N_PREFIX}.htmlVisionModel`}
									/>
								}
								tooltipTitle={
									<FormattedMessage
										id={`${OCR_SETTINGS_I18N_PREFIX}.htmlVisionModel.tip`}
									/>
								}
							/>
						}
					>
						<Select
							value={htmlVisionModel}
							onChange={(value) => {
								setHtmlVisionModel(value);
								updateAppSettings(
									AppSettingsGroup.FunctionOcr,
									{ htmlVisionModel: value },
									true,
									true,
									true,
									true,
									false,
								);
							}}
							options={htmlVisionModelOptions}
						/>
					</ProForm.Item>
				</Col>
			)}
		</Row>
	);
};

export const OcrToolModalSettings: React.FC<{
	onFinish: () => Promise<void>;
}> = ({ onFinish }) => {
	const intl = useIntl();

	return (
		<ModalForm
			title={<FormattedMessage id="draw.ocrToolModalSettings.title" />}
			trigger={
				<Button
					icon={<SettingOutlined />}
					title={intl.formatMessage({ id: "draw.ocrToolModalSettings.title" })}
					key="ocrToolModalSettings"
					type="text"
				/>
			}
			onFinish={async () => {
				await onFinish();
				return true;
			}}
			modalProps={{
				centered: true,
				forceRender: false,
			}}
		>
			{/* <GroupTitle id="translationSettings">
				<FormattedMessage id="settings.functionSettings.translationSettings" />
			</GroupTitle> */}
			<TranslationConfig />
			<OcrModelConfig />
		</ModalForm>
	);
};
