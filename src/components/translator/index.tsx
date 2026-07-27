import {
	CloseOutlined,
	ColumnHeightOutlined,
	ColumnWidthOutlined,
	CopyOutlined,
	SwapOutlined,
} from "@ant-design/icons";
import {
	Button,
	Col,
	Flex,
	Form,
	Row,
	Segmented,
	Select,
	type SelectProps,
	Spin,
	theme,
} from "antd";
import TextArea, { type TextAreaRef } from "antd/es/input/TextArea";
import { debounce } from "es-toolkit";
import React, {
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
	type TranslationServiceConfig,
	useTranslationRequest,
} from "@/core/translations";
import { useStateRef } from "@/hooks/useStateRef";
import { ModelSelectLabel } from "@/pages/tools/chat/components/modelSelectLabel";
import { TranslationApiType } from "@/types/appSettings";
import { TranslationDomain } from "@/types/servies/translation";
import { writeTextToClipboard } from "@/utils/clipboard";

const SelectLabel: React.FC<{
	label: React.ReactNode;
	code: React.ReactNode;
}> = ({ label, code }) => {
	const { token } = theme.useToken();
	return (
		<div className="language-item">
			<div className="language-item-label">{label}</div>
			<div className="language-item-code">{code}</div>

			<style jsx>{`
                .language-item {
                    position: relative;
                }

                .language-item-label {
                    display: inline;
                }

                .language-item-code {
                    display: inline;
                    color: ${token.colorTextDescription};
                    margin-left: ${token.marginXS}px;
                    font-size: 0.7em;
                    position: relative;
                    bottom: 0.15em;
                }
            `}</style>
		</div>
	);
};

type LanguageItem = {
	code: string;
	label: string;
};

const convertLanguageListToOptions = (
	list: LanguageItem[],
): SelectProps["options"] => {
	// 按首字母分组
	const groupedLanguages = list.reduce(
		(acc, lang) => {
			if (lang.code === "") {
				return acc;
			}

			const firstChar = lang.code.charAt(0).toUpperCase();
			if (!acc[firstChar]) {
				acc[firstChar] = [];
			}
			acc[firstChar].push(lang);
			return acc;
		},
		{} as Record<string, LanguageItem[]>,
	);

	// 转换为 Select 选项格式
	return Object.entries(groupedLanguages).map(([key, languages]) => {
		return {
			label: <span>{key}</span>,
			title: key,
			options: languages.map((lang) => {
				const langCode = typeof lang.code === "string" ? lang.code : "";

				return {
					label: (
						<SelectLabel label={lang.label} code={langCode.toUpperCase()} />
					),
					title: `${lang.label}(${langCode.toLowerCase()})`,
					value: langCode,
				};
			}),
		};
	});
};

const selectFilterOption: SelectProps["filterOption"] = (input, option) => {
	if (!input || !option?.title) return false;
	const pattern = input.toLowerCase().split("").join(".*");
	const regex = new RegExp(pattern, "i");
	return regex.test(option.title.toString().toLowerCase());
};

export type TranslatorActionType = {
	setSourceContent: (content: string, ignoreDebounce?: boolean) => void;
	getSourceContentRef: () => TextAreaRef | null;
	getTranslatedContent: () => { content: string }[];
};

export const useLanguageOptions = () => {
	const intl = useIntl();

	const targetLanguageOptions = useMemo(() => {
		const languageList = [
			{
				code: "en",
				label: intl.formatMessage({ id: "tools.translation.language.english" }),
			},
			{
				code: "zh-CHS",
				label: intl.formatMessage({
					id: "tools.translation.language.simplifiedChinese",
				}),
			},
			{
				code: "zh-CHT",
				label: intl.formatMessage({
					id: "tools.translation.language.traditionalChinese",
				}),
			},
			{
				code: "es",
				label: intl.formatMessage({ id: "tools.translation.language.spanish" }),
			},
			{
				code: "fr",
				label: intl.formatMessage({ id: "tools.translation.language.french" }),
			},
			{
				code: "ar",
				label: intl.formatMessage({ id: "tools.translation.language.arabic" }),
			},
			{
				code: "de",
				label: intl.formatMessage({ id: "tools.translation.language.german" }),
			},
			{
				code: "it",
				label: intl.formatMessage({ id: "tools.translation.language.italian" }),
			},
			{
				code: "ja",
				label: intl.formatMessage({
					id: "tools.translation.language.japanese",
				}),
			},
			{
				code: "pt",
				label: intl.formatMessage({
					id: "tools.translation.language.portuguese",
				}),
			},
			{
				code: "ru",
				label: intl.formatMessage({ id: "tools.translation.language.russian" }),
			},
			{
				code: "tr",
				label: intl.formatMessage({ id: "tools.translation.language.turkish" }),
			},
		].sort((a, b) => {
			if (a.code === "auto") {
				return -1;
			}
			if (b.code === "auto") {
				return 1;
			}
			return a.code.localeCompare(b.code);
		});

		return convertLanguageListToOptions(languageList);
	}, [intl]);

	const sourceLanguageOptions = useMemo(() => {
		return [
			{
				label: intl.formatMessage({ id: "tools.translation.language.auto" }),
				value: "auto",
			},
			...(targetLanguageOptions ?? []),
		];
	}, [intl, targetLanguageOptions]);

	return {
		sourceLanguageOptions,
		targetLanguageOptions,
	};
};

export const useTranslationTypeOptions = (
	supportedTranslationTypes: TranslationServiceConfig[],
) => {
	const translationTypeOptions = useMemo((): SelectProps["options"] => {
		const customTranslationTypeOptions: SelectProps["options"] = [];
		const officialTranslationTypeOptions: SelectProps["options"] = [];

		supportedTranslationTypes.forEach((item) => {
			if (item.isOfficial) {
				officialTranslationTypeOptions.push({
					label: <ModelSelectLabel modelName={item.name} />,
					value: item.type,
				});
			} else {
				customTranslationTypeOptions.push({
					label: <ModelSelectLabel modelName={item.name} />,
					value: item.type,
				});
			}
		});

		return [
			customTranslationTypeOptions.length > 0
				? {
						label: <FormattedMessage id="tools.translation.type.custom" />,
						options: customTranslationTypeOptions,
					}
				: undefined,
			{
				label: <FormattedMessage id="tools.translation.type.official" />,
				options: officialTranslationTypeOptions,
			},
		].filter(Boolean) as SelectProps["options"];
	}, [supportedTranslationTypes]);

	return {
		translationTypeOptions,
	};
};

export const useTranslationDomainOptions = () => {
	const intl = useIntl();

	return useMemo(
		() => [
			{
				label: intl.formatMessage({
					id: "tools.translation.domain.general",
				}),
				value: TranslationDomain.General,
			},
			{
				label: intl.formatMessage({
					id: "tools.translation.domain.computers",
				}),
				value: TranslationDomain.Computers,
			},
			{
				label: intl.formatMessage({
					id: "tools.translation.domain.medicine",
				}),
				value: TranslationDomain.Medicine,
			},
			{
				label: intl.formatMessage({
					id: "tools.translation.domain.finance",
				}),
				value: TranslationDomain.Finance,
			},
			{
				label: intl.formatMessage({
					id: "tools.translation.domain.game",
				}),
				value: TranslationDomain.Game,
			},
		],
		[intl],
	);
};

const TranslatorCore: React.FC<{
	actionRef: React.RefObject<TranslatorActionType | undefined>;
}> = ({ actionRef }) => {
	const intl = useIntl();

	const { token } = theme.useToken();

	const { sourceLanguageOptions, targetLanguageOptions } = useLanguageOptions();
	const translationDomainOptions = useTranslationDomainOptions();

	const translatedResultRef = useRef<{ content: string }[]>([]);
	const {
		sourceLanguage,
		targetLanguage,
		translationType,
		translationDomain,
		supportedTranslationTypes,
		startTranslateLoading,
		deltaTranslateLoading,
		updateSourceLanguage,
		updateTargetLanguage,
		updateTranslationType,
		updateTranslationDomain,
		supportedTranslationTypesLoading,
		requestTranslate,
		translatedContent,
		getTranslatedContent,
	} = useTranslationRequest(
		useMemo(() => {
			return {
				onComplete: (result) => {
					translatedResultRef.current = result;
				},
				enableCacheConfig: true,
			};
		}, []),
	);

	const ignoreDebounceRef = useRef<boolean>(false);
	const [sourceContent, setSourceContent] = useStateRef<string>("");

	const [translationLayout, setTranslationLayout] = useState<"horizontal" | "vertical">(
		() => {
			const saved = localStorage.getItem("translation-layout");
			return saved === "vertical" ? "vertical" : "horizontal";
		},
	);
	useEffect(() => {
		localStorage.setItem("translation-layout", translationLayout);
	}, [translationLayout]);
	const isVerticalLayout = translationLayout === "vertical";

	const requestTranslateDebounce = useMemo(
		() => debounce(requestTranslate, 1500),
		[requestTranslate],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 翻译相关配置变更的时候也要重新翻译
	useEffect(() => {
		if (sourceContent.trim() === "") {
			return;
		}

		if (ignoreDebounceRef.current) {
			ignoreDebounceRef.current = false;
			setTimeout(() => {
				requestTranslate([sourceContent]);
			}, 17);
		} else {
			requestTranslateDebounce([sourceContent]);
		}
	}, [
		sourceContent,
		requestTranslateDebounce,
		requestTranslate,
		translationType,
		sourceLanguage,
		targetLanguage,
		translationDomain,
	]);

	const supportDomain = useMemo(() => {
		if (translationType === TranslationApiType.DeepL) {
			return false;
		}

		return true;
	}, [translationType]);

	const onCopy = useCallback(() => {
		if (!getTranslatedContent()) {
			return;
		}
		writeTextToClipboard(getTranslatedContent());
	}, [getTranslatedContent]);

	const hasSourceContent = !!sourceContent;
	const hasTranslatedContent = !!translatedContent;

	const { translationTypeOptions } = useTranslationTypeOptions(
		supportedTranslationTypes,
	);

	const sourceContentRef = useRef<TextAreaRef>(null);
	useImperativeHandle(
		actionRef,
		useCallback(
			() => ({
				setSourceContent: (content: string, ignoreDebounce?: boolean) => {
					setSourceContent(content);
					ignoreDebounceRef.current = ignoreDebounce ?? false;
				},
				getSourceContentRef: () => sourceContentRef.current,
				getTranslatedContent: () => translatedResultRef.current,
			}),
			[setSourceContent],
		),
	);

	return (
		<>
			{/* 用表单处理下样式，但不用表单处理数据验证 */}
			<Form className="tool-translator-container" layout="vertical">
				<Flex gap={0} justify="space-between">
					<Flex gap={0} align="center">
						<Form.Item
							style={{ marginBottom: token.marginXS }}
							label={<FormattedMessage id="tools.translation.sourceLanguage" />}
						>
							<Select
								value={sourceLanguage}
								showSearch
								onChange={(value) => updateSourceLanguage(value)}
								options={sourceLanguageOptions}
								variant="underlined"
								styles={{
									popup: {
										root: {
											minWidth: 200,
										},
									},
								}}
								filterOption={selectFilterOption}
							/>
						</Form.Item>
						<Button
							type="link"
							disabled={
								sourceLanguage === "auto" || sourceLanguage === targetLanguage
							}
							icon={<SwapOutlined />}
							style={{ marginTop: token.margin }}
							onClick={() => {
								updateSourceLanguage(targetLanguage);
								updateTargetLanguage(sourceLanguage);
							}}
						/>
						<Form.Item
							style={{ marginBottom: token.marginXS }}
							label={<FormattedMessage id="tools.translation.targetLanguage" />}
						>
							<Select
								showSearch
								value={targetLanguage}
								onChange={(value) => {
									updateTargetLanguage(value);
								}}
								options={targetLanguageOptions}
								filterOption={selectFilterOption}
								styles={{
									popup: {
										root: {
											minWidth: 200,
										},
									},
								}}
								variant="underlined"
							/>
						</Form.Item>
					</Flex>
					<Flex gap={token.margin}>
						<Form.Item
							style={{ marginBottom: token.marginXS }}
							label={<FormattedMessage id="tools.translation.type" />}
						>
							<Select
								showSearch
								value={translationType}
								onChange={(value) => {
									updateTranslationType(value);
								}}
								options={translationTypeOptions}
								loading={supportedTranslationTypesLoading}
								filterOption={selectFilterOption}
								styles={{
									popup: {
										root: {
											minWidth: 200,
										},
									},
								}}
								variant="underlined"
							/>
						</Form.Item>
						<Form.Item
							style={{ marginBottom: token.marginXS }}
							label={<FormattedMessage id="tools.translation.domain" />}
							hidden={!supportDomain}
						>
							<Select
								showSearch
								value={translationDomain}
								onChange={(value) => {
									updateTranslationDomain(value);
								}}
								options={translationDomainOptions}
								filterOption={selectFilterOption}
								styles={{
									popup: {
										root: {
											minWidth: 200,
										},
									},
								}}
								variant="underlined"
							/>
						</Form.Item>
						<Form.Item
							style={{ marginBottom: token.marginXS }}
							label={<FormattedMessage id="tools.translation.layout" />}
						>
							<Segmented
								value={translationLayout}
								onChange={(value) =>
									setTranslationLayout(value as "horizontal" | "vertical")
								}
								options={[
									{
										value: "horizontal",
										icon: <ColumnWidthOutlined />,
										title: intl.formatMessage({
											id: "tools.translation.layout.horizontal",
										}),
									},
									{
										value: "vertical",
										icon: <ColumnHeightOutlined />,
										title: intl.formatMessage({
											id: "tools.translation.layout.vertical",
										}),
									},
								]}
							/>
						</Form.Item>
					</Flex>
				</Flex>
				<Row
					gutter={[
						token.marginLG,
						isVerticalLayout ? token.marginLG : 0,
					]}
					style={{ marginTop: token.marginXXS }}
				>
					<Col span={isVerticalLayout ? 24 : 12} style={{ position: "relative" }}>
						<TextArea
							rows={isVerticalLayout ? 6 : 12}
							maxLength={5000}
							showCount
							autoSize={{ minRows: isVerticalLayout ? 6 : 12 }}
							placeholder={intl.formatMessage({
								id: "tools.translation.placeholder",
							})}
							value={sourceContent}
							style={{ flex: 1 }}
							onChange={(e) => setSourceContent(e.target.value)}
							ref={sourceContentRef}
						/>

						<Button
							className="tool-translator-container-clear-button"
							type="text"
							shape="circle"
							icon={<CloseOutlined />}
							onClick={() => {
								setSourceContent("");
							}}
						/>
					</Col>
					<Col span={isVerticalLayout ? 24 : 12}>
						<Spin spinning={startTranslateLoading}>
							<div style={{ position: "relative" }}>
								<Spin
									spinning={deltaTranslateLoading}
									style={{
										position: "absolute",
										bottom: token.margin,
										right: token.marginLG,
									}}
								/>
								<TextArea
									rows={isVerticalLayout ? 6 : 12}
									variant="filled"
									style={{ flex: 1 }}
									autoSize={{ minRows: isVerticalLayout ? 6 : 12 }}
									readOnly
									value={translatedContent}
								/>

								<Flex
									className="tool-translator-container-translate-button-container"
									gap={token.marginXXS}
									align="center"
									justify="end"
								>
									<Button
										type="text"
										shape="circle"
										icon={<CopyOutlined />}
										onClick={onCopy}
									/>
								</Flex>
							</div>
						</Spin>
					</Col>
				</Row>
			</Form>

			<style jsx>{`
                :global(.tool-translator-container .ant-form-item-label) {
                    padding-bottom: ${token.paddingXXS}px !important;
                }

                :global(.tool-translator-container .ant-form-item-label label) {
                    font-size: 12px !important;
                    color: ${token.colorTextDescription} !important;
                }

                :global(.tool-translator-container .ant-input) {
                    padding-right: ${32 + token.marginXXS * 2}px !important;
                }

                :global(.tool-translator-container-clear-button) {
                    position: absolute !important;
                    right: ${token.paddingXS + token.marginXXS}px;
                    top: ${token.marginXXS}px;
                    z-index: 1;
                    pointer-events: ${hasSourceContent ? "auto" : "none"};
                    opacity: ${hasSourceContent ? 1 : 0};
                    transition: opacity ${token.motionDurationMid} ${token.motionEaseInOut};
                }

                :global(.tool-translator-container-translate-button-container) {
                    position: absolute;
                    bottom: ${token.marginXXS}px;
                    right: ${token.marginXXS}px;
                    z-index: 1;
                    pointer-events: ${hasTranslatedContent ? "auto" : "none"};
                    opacity: ${hasTranslatedContent ? 1 : 0};
                    transition: opacity ${token.motionDurationMid} ${token.motionEaseInOut};
                }
            `}</style>
		</>
	);
};

export const Translator = React.memo(TranslatorCore);
