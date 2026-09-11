import {
	ProFormDependency,
	ProFormList,
	ProFormSelect,
	ProFormText,
} from "@ant-design/pro-components";
import { Col, Flex, Row, theme } from "antd";
import { useMemo } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { IconLabel } from "@/components/iconLable";
import { OnlineOcrServiceType } from "@/types/appSettings";

const OCR_SETTINGS_I18N_PREFIX = "settings.functionSettings.ocrSettings";

type OnlineOcrServiceTypeItem = {
	providerLabelId: string;
	value: OnlineOcrServiceType;
	labelId: string;
};

const ONLINE_OCR_SERVICE_TYPE_LIST: OnlineOcrServiceTypeItem[] = [
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.youdao`,
		value: OnlineOcrServiceType.YoudaoOcr,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.youdaoOcr`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.youdao`,
		value: OnlineOcrServiceType.YoudaoImageTranslation,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.youdaoImageTranslation`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.aliyun`,
		value: OnlineOcrServiceType.AliyunImageTranslation,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.aliyunImageTranslation`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.volcengine`,
		value: OnlineOcrServiceType.VolcengineImageTranslation,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.volcengineImageTranslation`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.baidu`,
		value: OnlineOcrServiceType.BaiduImageTranslation,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.baiduImageTranslation`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.baidu`,
		value: OnlineOcrServiceType.BaiduGeneralAccurate,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.baiduGeneralAccurate`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.baidu`,
		value: OnlineOcrServiceType.BaiduGeneral,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.baiduGeneral`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.baidu`,
		value: OnlineOcrServiceType.BaiduWebImageLocation,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.baiduWebImageLocation`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.baidu`,
		value: OnlineOcrServiceType.BaiduGeneralAccurateBasic,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.baiduGeneralAccurateBasic`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.baidu`,
		value: OnlineOcrServiceType.BaiduGeneralBasic,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.baiduGeneralBasic`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.baidu`,
		value: OnlineOcrServiceType.BaiduWebImage,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.baiduWebImage`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.baidu`,
		value: OnlineOcrServiceType.BaiduHandwriting,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.baiduHandwriting`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.tencent`,
		value: OnlineOcrServiceType.TencentGeneralBasicOcr,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.tencentGeneralBasicOcr`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.tencent`,
		value: OnlineOcrServiceType.TencentGeneralAccurateOcr,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.tencentGeneralAccurateOcr`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.baidu`,
		value: OnlineOcrServiceType.BaiduGeneralBasic,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.baiduGeneralBasic`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.baidu`,
		value: OnlineOcrServiceType.BaiduGeneralAccurateBasic,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.baiduGeneralAccurateBasic`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.aliyun`,
		value: OnlineOcrServiceType.AliyunRecognizeGeneral,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.aliyunRecognizeGeneral`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.aliyun`,
		value: OnlineOcrServiceType.AliyunRecognizeHandwriting,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.aliyunRecognizeHandwriting`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.volcengine`,
		value: OnlineOcrServiceType.VolcengineOcrNormal,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.volcengineOcrNormal`,
	},
	{
		providerLabelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.provider.custom`,
		value: OnlineOcrServiceType.Custom,
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.service.custom`,
	},
];

type OnlineOcrLanguageItem = {
	value: string;
	labelId: string;
};

const YOUDAO_LANGUAGE_LIST: OnlineOcrLanguageItem[] = [
	{ value: "auto", labelId: "tools.translation.language.auto" },
	{ value: "zh-CHS", labelId: "tools.translation.language.simplifiedChinese" },
	{ value: "zh-CHT", labelId: "tools.translation.language.traditionalChinese" },
	{ value: "en", labelId: "tools.translation.language.english" },
	{ value: "ja", labelId: "tools.translation.language.japanese" },
	{ value: "ko", labelId: "tools.translation.language.korean" },
	{ value: "fr", labelId: "tools.translation.language.french" },
	{ value: "de", labelId: "tools.translation.language.german" },
	{ value: "es", labelId: "tools.translation.language.spanish" },
	{ value: "ru", labelId: "tools.translation.language.russian" },
	{ value: "pt", labelId: "tools.translation.language.portuguese" },
	{ value: "it", labelId: "tools.translation.language.italian" },
	{ value: "th", labelId: "tools.translation.language.thai" },
	{ value: "vi", labelId: "tools.translation.language.vietnamese" },
	{ value: "id", labelId: "tools.translation.language.indonesian" },
	{ value: "hi", labelId: "tools.translation.language.hindi" },
	{ value: "ar", labelId: "tools.translation.language.arabic" },
	{ value: "tr", labelId: "tools.translation.language.turkish" },
	{ value: "ms", labelId: "tools.translation.language.malay" },
	{ value: "nl", labelId: "tools.translation.language.dutch" },
];

const TENCENT_GENERAL_BASIC_LANGUAGE_LIST: OnlineOcrLanguageItem[] = [
	{ value: "auto", labelId: "tools.translation.language.auto" },
	{
		value: "zh",
		labelId: "tools.translation.language.simplifiedChinese",
	},
	{
		value: "zh_rare",
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.language.rareChinese`,
	},
	{
		value: "mix",
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.language.chineseEnglishMix`,
	},
	{ value: "jap", labelId: "tools.translation.language.japanese" },
	{ value: "kor", labelId: "tools.translation.language.korean" },
	{ value: "spa", labelId: "tools.translation.language.spanish" },
	{ value: "fre", labelId: "tools.translation.language.french" },
	{ value: "ger", labelId: "tools.translation.language.german" },
	{ value: "por", labelId: "tools.translation.language.portuguese" },
	{ value: "vie", labelId: "tools.translation.language.vietnamese" },
	{ value: "may", labelId: "tools.translation.language.malay" },
	{ value: "rus", labelId: "tools.translation.language.russian" },
	{ value: "ita", labelId: "tools.translation.language.italian" },
	{ value: "hol", labelId: "tools.translation.language.dutch" },
	{ value: "swe", labelId: "tools.translation.language.swedish" },
	{ value: "fin", labelId: "tools.translation.language.finnish" },
	{ value: "dan", labelId: "tools.translation.language.danish" },
	{ value: "nor", labelId: "tools.translation.language.norwegian" },
	{ value: "hun", labelId: "tools.translation.language.hungarian" },
	{ value: "tha", labelId: "tools.translation.language.thai" },
	{ value: "hi", labelId: "tools.translation.language.hindi" },
	{ value: "ara", labelId: "tools.translation.language.arabic" },
];

const TENCENT_GENERAL_ACCURATE_LANGUAGE_LIST: OnlineOcrLanguageItem[] = [
	{
		value: "auto",
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.language.autoChineseEnglish`,
	},
	{
		value: "mul",
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.language.multipleLanguages`,
	},
];

const BAIDU_LANGUAGE_LIST: OnlineOcrLanguageItem[] = [
	{ value: "auto_detect", labelId: "tools.translation.language.auto" },
	{
		value: "CHN_ENG",
		labelId: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.language.chineseEnglishMix`,
	},
	{ value: "ENG", labelId: "tools.translation.language.english" },
	{ value: "JAP", labelId: "tools.translation.language.japanese" },
	{ value: "KOR", labelId: "tools.translation.language.korean" },
	{ value: "FRE", labelId: "tools.translation.language.french" },
	{ value: "SPA", labelId: "tools.translation.language.spanish" },
	{ value: "POR", labelId: "tools.translation.language.portuguese" },
	{ value: "GER", labelId: "tools.translation.language.german" },
	{ value: "ITA", labelId: "tools.translation.language.italian" },
	{ value: "RUS", labelId: "tools.translation.language.russian" },
	{ value: "DAN", labelId: "tools.translation.language.danish" },
	{ value: "DUT", labelId: "tools.translation.language.dutch" },
	{ value: "MAL", labelId: "tools.translation.language.malay" },
	{ value: "SWE", labelId: "tools.translation.language.swedish" },
	{ value: "IND", labelId: "tools.translation.language.indonesian" },
	{ value: "POL", labelId: "tools.translation.language.polish" },
	{ value: "ROM", labelId: "tools.translation.language.romanian" },
	{ value: "TUR", labelId: "tools.translation.language.turkish" },
	{ value: "GRE", labelId: "tools.translation.language.greek" },
	{ value: "HUN", labelId: "tools.translation.language.hungarian" },
	{ value: "THA", labelId: "tools.translation.language.thai" },
	{ value: "VIE", labelId: "tools.translation.language.vietnamese" },
	{ value: "ARA", labelId: "tools.translation.language.arabic" },
	{ value: "HIN", labelId: "tools.translation.language.hindi" },
];

export const useOnlineOcrServiceTypeOptions = () => {
	const intl = useIntl();

	return useMemo(() => {
		const providerGroups = new Map<
			string,
			{ label: string; value: string }[]
		>();

		ONLINE_OCR_SERVICE_TYPE_LIST.forEach((item) => {
			const providerLabel = intl.formatMessage({ id: item.providerLabelId });
			if (!providerGroups.has(providerLabel)) {
				providerGroups.set(providerLabel, []);
			}

			providerGroups.get(providerLabel)?.push({
				label: intl.formatMessage({ id: item.labelId }),
				value: item.value,
			});
		});

		return Array.from(providerGroups.entries()).map(([label, options]) => ({
			label,
			title: label,
			options,
		}));
	}, [intl]);
};

const useOnlineOcrLanguageOptions = (serviceType: string | undefined) => {
	const intl = useIntl();

	return useMemo(() => {
		let languageList: OnlineOcrLanguageItem[];
		switch (serviceType) {
			case OnlineOcrServiceType.YoudaoOcr:
			case OnlineOcrServiceType.YoudaoImageTranslation:
				languageList = YOUDAO_LANGUAGE_LIST;
				break;
			case OnlineOcrServiceType.TencentGeneralBasicOcr:
				languageList = TENCENT_GENERAL_BASIC_LANGUAGE_LIST;
				break;
			case OnlineOcrServiceType.TencentGeneralAccurateOcr:
				languageList = TENCENT_GENERAL_ACCURATE_LANGUAGE_LIST;
				break;
			case OnlineOcrServiceType.BaiduGeneralBasic:
			case OnlineOcrServiceType.BaiduGeneral:
				languageList = BAIDU_LANGUAGE_LIST;
				break;
			default:
				// 腾讯云图片翻译自动识别源语言，无源语言选项
				return [];
		}

		return languageList.map((item) => ({
			value: item.value,
			label: intl.formatMessage({ id: item.labelId }),
		}));
	}, [intl, serviceType]);
};

const useOnlineOcrTargetLanguageOptions = (
	serviceType: string | undefined,
) => {
	const intl = useIntl();

	return useMemo(() => {
		let languageList: OnlineOcrLanguageItem[];
		switch (serviceType) {
			case OnlineOcrServiceType.YoudaoImageTranslation:
			case OnlineOcrServiceType.AliyunImageTranslation:
			case OnlineOcrServiceType.VolcengineImageTranslation:
			case OnlineOcrServiceType.BaiduImageTranslation:
				languageList = YOUDAO_LANGUAGE_LIST;
				break;
			default:
				return [];
		}

		return languageList
			.filter((item) => item.value !== "auto")
			.map((item) => ({
				value: item.value,
				label: intl.formatMessage({ id: item.labelId }),
			}));
	}, [intl, serviceType]);
};

const OnlineOcrTargetLanguageField: React.FC<{ serviceType?: string }> = ({
	serviceType,
}) => {
	const targetLanguageOptions = useOnlineOcrTargetLanguageOptions(serviceType);

	if (targetLanguageOptions.length === 0) {
		return null;
	}

	return (
		<Col span={12}>
			<ProFormSelect
				name="target_language"
				initialValue="zh-CHS"
				label={
					<IconLabel
						label={
							<FormattedMessage
								id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.targetLanguage`}
							/>
						}
					/>
				}
				allowClear={false}
				options={targetLanguageOptions}
			/>
		</Col>
	);
};

const OnlineOcrLanguageField: React.FC<{ serviceType?: string }> = ({
	serviceType,
}) => {
	const languageOptions = useOnlineOcrLanguageOptions(serviceType);

	if (languageOptions.length === 0) {
		return null;
	}

	return (
		<Col span={12}>
			<ProFormSelect
				name="language"
				label={
					<IconLabel
						label={
							<FormattedMessage
								id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.language`}
							/>
						}
					/>
				}
				allowClear={false}
				options={languageOptions}
			/>
		</Col>
	);
};

const isTencentServiceType = (serviceType?: string) => {
	return (
		serviceType === OnlineOcrServiceType.TencentGeneralBasicOcr ||
		serviceType === OnlineOcrServiceType.TencentGeneralAccurateOcr
	);
};

export const OnlineOcrConfig = () => {
	const intl = useIntl();
	const { token } = theme.useToken();

	const serviceTypeOptions = useOnlineOcrServiceTypeOptions();

	return (
		<ProFormList
			name="onlineOcrModelConfigList"
			label={
				<IconLabel
					label={
						<FormattedMessage
							id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig`}
						/>
					}
				/>
			}
			creatorButtonProps={{
				creatorButtonText: intl.formatMessage({
					id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.add`,
				}),
			}}
			className="api-config-list"
			min={0}
			itemRender={({ listDom, action }) => (
				<Flex align="end" justify="space-between">
					{listDom}
					<div>{action}</div>
				</Flex>
			)}
			creatorRecord={() => ({
				model_name: "",
				service_type: OnlineOcrServiceType.TencentGeneralBasicOcr,
				language: "auto",
				target_language: "zh-CHS",
				api_uri: "",
				api_key: "",
				app_key: "",
				app_secret: "",
				secret_id: "",
				secret_key: "",
				region: "ap-guangzhou",
			})}
		>
			<Row gutter={token.marginLG} style={{ width: "100%" }}>
					<Col span={12}>
						<ProFormText
							name="model_name"
							label={
								<IconLabel
									label={
										<FormattedMessage
										id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.modelName`}
									/>
								}
								tooltipTitle={
									<FormattedMessage
										id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.modelName.tip`}
									/>
								}
							/>
						}
					/>
				</Col>
			<Col span={12}>
					<ProFormSelect
						name="service_type"
						label={
							<IconLabel
								label={
									<FormattedMessage
									id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.serviceType`}
								/>
							}
						/>
					}
					allowClear={false}
					options={serviceTypeOptions}
				/>
			</Col>
				<ProFormDependency name={["service_type"]}>
					{({ service_type }) => (
						<>
							<OnlineOcrLanguageField serviceType={service_type} />
							<OnlineOcrTargetLanguageField serviceType={service_type} />
						</>
					)}
				</ProFormDependency>
				<ProFormDependency name={["service_type"]}>
					{({ service_type }) => {
						if (service_type === OnlineOcrServiceType.Custom) {
							return (
								<Col span={12}>
									<ProFormText
										name="api_uri"
										label={
											<IconLabel
												label={
													<FormattedMessage
														id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.apiUri`}
													/>
												}
											/>
										}
										rules={[
											{
												required: true,
												message: intl.formatMessage({
													id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.apiUri.required`,
												}),
											},
										]}
									/>
								</Col>
							);
						}

						if (
							service_type === OnlineOcrServiceType.YoudaoOcr ||
							service_type === OnlineOcrServiceType.YoudaoImageTranslation
						) {
							return (
								<>
									<Col span={12}>
										<ProFormText
											name="app_key"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.appKey`}
														/>
													}
												/>
											}
											rules={[
												{
													required: true,
													message: intl.formatMessage({
														id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.appKey.required`,
													}),
												},
											]}
										/>
									</Col>
									<Col span={12}>
										<ProFormText.Password
											name="app_secret"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.appSecret`}
														/>
													}
												/>
											}
											rules={[
												{
													required: true,
													message: intl.formatMessage({
														id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.appSecret.required`,
													}),
												},
											]}
										/>
									</Col>
								</>
							);
						}

						if (isTencentServiceType(service_type)) {
							return (
								<>
									<Col span={12}>
										<ProFormText
											name="region"
											disabled={true}
											initialValue="ap-guangzhou"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.region`}
														/>
													}
												/>
											}
										/>
									</Col>
									<Col span={12}>
										<ProFormText
											name="secret_id"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.secretId`}
														/>
													}
												/>
											}
											rules={[
												{
													required: true,
													message: intl.formatMessage({
														id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.secretId.required`,
													}),
												},
											]}
										/>
									</Col>
									<Col span={12}>
										<ProFormText.Password
											name="secret_key"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.secretKey`}
														/>
													}
												/>
											}
											rules={[
												{
													required: true,
													message: intl.formatMessage({
														id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.secretKey.required`,
													}),
												},
											]}
										/>
									</Col>
								</>
							);
						}

						if (
							service_type === OnlineOcrServiceType.BaiduGeneralBasic ||
							service_type === OnlineOcrServiceType.BaiduGeneralAccurateBasic ||
							service_type === OnlineOcrServiceType.BaiduImageTranslation
						) {
							return (
								<>
									<Col span={12}>
										<ProFormText
											name="api_key"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.baiduApiKey`}
														/>
													}
												/>
											}
											rules={[
												{
													required: true,
													message: intl.formatMessage({
														id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.baiduApiKey.required`,
													}),
												},
											]}
										/>
									</Col>
									<Col span={12}>
										<ProFormText.Password
											name="secret_key"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.baiduSecretKey`}
														/>
													}
												/>
											}
											rules={[
												{
													required: true,
													message: intl.formatMessage({
														id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.baiduSecretKey.required`,
													}),
												},
											]}
										/>
									</Col>
								</>
							);
						}

						if (
							service_type === OnlineOcrServiceType.AliyunRecognizeGeneral ||
							service_type === OnlineOcrServiceType.AliyunImageTranslation
						) {
							return (
								<>
									<Col span={12}>
										<ProFormText
											name="secret_id"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.accessKeyId`}
														/>
													}
												/>
											}
											rules={[
												{
													required: true,
													message: intl.formatMessage({
														id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.accessKeyId.required`,
													}),
												},
											]}
										/>
									</Col>
									<Col span={12}>
										<ProFormText.Password
											name="secret_key"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.accessKeySecret`}
														/>
													}
												/>
											}
											rules={[
												{
													required: true,
													message: intl.formatMessage({
														id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.accessKeySecret.required`,
													}),
												},
											]}
										/>
									</Col>
								</>
							);
						}

						if (
							service_type === OnlineOcrServiceType.VolcengineOcrNormal ||
							service_type === OnlineOcrServiceType.VolcengineImageTranslation
						) {
							return (
								<>
									<Col span={12}>
										<ProFormText
											name="secret_id"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.accessKeyId`}
														/>
													}
												/>
											}
											rules={[
												{
													required: true,
													message: intl.formatMessage({
														id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.accessKeyId.required`,
													}),
												},
											]}
										/>
									</Col>
									<Col span={12}>
										<ProFormText.Password
											name="secret_key"
											label={
												<IconLabel
													label={
														<FormattedMessage
															id={`${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.secretAccessKey`}
														/>
													}
												/>
											}
											rules={[
												{
													required: true,
													message: intl.formatMessage({
														id: `${OCR_SETTINGS_I18N_PREFIX}.onlineOcrModelConfig.secretAccessKey.required`,
													}),
												},
											]}
										/>
									</Col>
								</>
							);
						}

						return null;
					}}
				</ProFormDependency>
			</Row>
		</ProFormList>
	);
};
