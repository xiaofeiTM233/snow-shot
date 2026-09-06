import { trim } from "es-toolkit";
import OpenAI from "openai";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { defaultTranslationPrompt } from "@/constants/components/translation";
import { AntdContext } from "@/contexts/antdContext";
import { AppSettingsActionContext } from "@/contexts/appSettingsActionContext";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { useStateRef } from "@/hooks/useStateRef";
import {
	convertLanguageCodeToDeepLSourceLanguageCode,
	convertLanguageCodeToDeepLTargetLanguageCode,
} from "@/pages/settings/functionSettings/extra";
import { CUSTOM_MODEL_PREFIX } from "@/pages/tools/chat/page";
import { getTranslationPrompt } from "@/pages/tools/translation/extra";
import { appFetch, getUrl, type ServiceResponse } from "@/services/tools";
import { type ChatModel, getChatModelsWithCache } from "@/services/tools/chat";
import {
	getTranslationTypesWithCache,
	translate,
	translateTextCustomWithLimits,
	translateTextDeepL,
	translateTextGoogle,
	translateTextMicrosoft,
} from "@/services/tools/translation";
import {
	translateText,
	toOnlineTranslationConfig,
} from "@/commands/translation";
import {
	type AppSettingsData,
	AppSettingsGroup,
	type ChatApiConfig,
	type TranslationApiConfig,
	TranslationApiType,
} from "@/types/appSettings";
import {
	type DeepLTranslateResult,
	type TranslateData,
	TranslationDomain,
	TranslationType,
	type TranslationTypeOption,
} from "@/types/servies/translation";
import { appError } from "@/utils/log";

export type TranslationServiceConfig = (
	| TranslationTypeOption
	| {
			name: string;
			type: string;
			apiConfig: ChatApiConfig;
	  }
	| {
			name: string;
			type: TranslationApiType;
			translationApiConfig: TranslationApiConfig;
	  }
) & {
	isOfficial: boolean;
};

export const useTranslationRequest = (options?: {
	/// 配置从 Cache 中加载
	enableCacheConfig?: boolean;
	onComplete?: (result: { content: string }[], requestId?: number) => void;
	onDeltaContent?: (deltaContent: string) => void;
	/// 懒加载
	lazyLoad?: boolean;
}) => {
	const intl = useIntl();
	const { message } = useContext(AntdContext);

	// 翻译领域
	const [translationDomain, setTranslationDomain, translationDomainRef] =
		useStateRef<TranslationDomain>(TranslationDomain.General);
	// 翻译类型
	const [translationType, setTranslationType, translationTypeRef] = useStateRef<
		TranslationType | string
	>(TranslationType.Youdao);
	// 源语言
	const [sourceLanguage, setSourceLanguage, sourceLanguageRef] =
		useStateRef<string>("auto");
	// 目标语言
	const [targetLanguage, setTargetLanguage, targetLanguageRef] =
		useStateRef<string>("zh-CHS");

	// 用户自定义的 AI 对话配置
	const [chatApiConfigList, setChatApiConfigList] = useState<
		ChatApiConfig[] | undefined
	>(undefined);
	/// 用户自定义的翻译 API 配置
	const [translationApiConfigList, setTranslationApiConfigList] = useState<
		TranslationApiConfig[] | undefined
	>(undefined);
	// Snow Shot 自带的
	const [
		officialTranslationTypes,
		setOfficialTranslationTypes,
		officialTranslationTypesRef,
	] = useStateRef<TranslationTypeOption[] | undefined>(undefined);
	const [officialChatModels, setOfficialChatModels, officialChatModelsRef] =
		useStateRef<ChatModel[] | undefined>(undefined);
	const [chatConfig, setChatConfig] =
		useState<AppSettingsData[AppSettingsGroup.SystemChat]>();
	const [translationConfig, setTranslationConfig] =
		useState<AppSettingsData[AppSettingsGroup.FunctionTranslation]>();

	useAppSettingsLoad(
		useCallback(
			(settings: AppSettingsData) => {
				if (options?.enableCacheConfig) {
					setTranslationDomain(
						settings[AppSettingsGroup.FunctionTranslationCache]
							.cacheTranslationDomain,
					);
					setTranslationType(
						settings[AppSettingsGroup.FunctionTranslationCache]
							.cacheTranslationType,
					);
					setSourceLanguage(
						settings[AppSettingsGroup.FunctionTranslationCache]
							.cacheSourceLanguage,
					);
					setTargetLanguage(
						settings[AppSettingsGroup.FunctionTranslationCache]
							.cacheTargetLanguage,
					);
				} else {
					setTranslationDomain(
						settings[AppSettingsGroup.FunctionTranslation].translationDomain,
					);
					setTranslationType(
						settings[AppSettingsGroup.FunctionTranslation].translationType,
					);
					setSourceLanguage(
						settings[AppSettingsGroup.FunctionTranslation].sourceLanguage,
					);
					setTargetLanguage(
						settings[AppSettingsGroup.FunctionTranslation].targetLanguage,
					);
				}

				setChatApiConfigList(
					settings[AppSettingsGroup.FunctionChat].chatApiConfigList,
				);
				setTranslationApiConfigList(
					settings[AppSettingsGroup.FunctionTranslation]
						.translationApiConfigList,
				);

				setChatConfig(settings[AppSettingsGroup.SystemChat]);
				setTranslationConfig(settings[AppSettingsGroup.FunctionTranslation]);
			},
			[
				setSourceLanguage,
				setTargetLanguage,
				setTranslationDomain,
				setTranslationType,
				options?.enableCacheConfig,
			],
		),
		true,
	);
	const { updateAppSettings } = useContext(AppSettingsActionContext);

	const reloadOnlineConfigsPromiseRef = useRef<
		Promise<[undefined, undefined]> | undefined
	>(undefined);
	const reloadOnlineConfigs = useCallback(async () => {
		if (officialTranslationTypesRef.current && officialChatModelsRef.current) {
			return;
		}

		const promise = Promise.all([
			getTranslationTypesWithCache().then((res) => {
				setOfficialTranslationTypes(res ?? []);
				return undefined;
			}),
			getChatModelsWithCache().then((res) => {
				setOfficialChatModels(res ?? []);
				return undefined;
			}),
		]);
		reloadOnlineConfigsPromiseRef.current = promise;
		await promise;
	}, [
		setOfficialChatModels,
		setOfficialTranslationTypes,
		officialChatModelsRef,
		officialTranslationTypesRef,
	]);

	useEffect(() => {
		if (options?.lazyLoad) {
			return;
		}

		reloadOnlineConfigs();
	}, [reloadOnlineConfigs, options?.lazyLoad]);

	const [
		supportedTranslationTypes,
		setSupportedTranslationTypes,
		supportedTranslationTypesRef,
	] = useStateRef<TranslationServiceConfig[]>([]);

	const getTranslationApiConfigTypeName = useCallback(
		(apiConfigType: TranslationApiType) => {
			switch (apiConfigType) {
				case TranslationApiType.DeepL:
					return intl.formatMessage({ id: "tools.translation.type.deepl" });
				case TranslationApiType.Custom:
					return intl.formatMessage({ id: "tools.translation.type.custom" });
				case TranslationApiType.Youdao:
					return intl.formatMessage({ id: "tools.translation.type.youdaoApi" });
				case TranslationApiType.Tencent:
					return intl.formatMessage({ id: "tools.translation.type.tencent" });
				default:
					return apiConfigType;
			}
		},
		[intl],
	);

	const [
		supportedTranslationTypesLoading,
		setSupportedTranslationTypesLoading,
	] = useState(false);
	useEffect(() => {
		setSupportedTranslationTypesLoading(true);
		setSupportedTranslationTypes([
			// 谷歌翻译（内置）
			{
				type: TranslationType.Google,
				name: intl.formatMessage({ id: "tools.translation.type.google" }),
				isOfficial: true,
			},
			// 微软翻译（内置）
			{
				type: TranslationType.Microsoft,
				name: intl.formatMessage({ id: "tools.translation.type.microsoft" }),
				isOfficial: true,
			},
			...(chatApiConfigList?.map((item): TranslationServiceConfig => {
				return {
					type: `${CUSTOM_MODEL_PREFIX}${item.api_model}`,
					name: item.model_name,
					apiConfig: {
						...item,
						support_thinking: false,
					},
					isOfficial: false,
				};
			}) ?? []),
			...(translationApiConfigList?.map((item): TranslationServiceConfig => {
				return {
					type: item.api_type,
					name: getTranslationApiConfigTypeName(item.api_type),
					translationApiConfig: item,
					isOfficial: false,
				};
			}) ?? []),
			...(officialTranslationTypes ?? []).map(
				(item): TranslationServiceConfig => {
					return {
						type: item.type,
						name: item.name,
						isOfficial: true,
					};
				},
			),
			...(officialChatModels ?? []).map((item): TranslationServiceConfig => {
				return {
					type: item.model,
					name: item.name,
					apiConfig: {
						api_uri: getUrl("api/v1/"),
						api_key: "",
						api_model: item.model,
						model_name: item.name,
						support_thinking: false,
						support_vision: false,
					},
					isOfficial: true,
				};
			}),
		]);
		setSupportedTranslationTypesLoading(false);
	}, [
		chatApiConfigList,
		setSupportedTranslationTypes,
		translationApiConfigList,
		officialChatModels,
		officialTranslationTypes,
		getTranslationApiConfigTypeName,
		intl,
	]);

	// 请求翻译的加载
	const [startTranslateLoading, setStartTranslateLoading] = useState(false);
	// 翻译内容的加载
	const [deltaTranslateLoading, setDeltaTranslateLoading] = useState(false);
	const [translatedContent, setTranslatedContent, translatedContentRef] =
		useStateRef<string>("");

	const customTranslation = useCallback(
		async (params: {
			sourceContent: string[];
			sourceLanguage: string;
			targetLanguage: string;
			translationType: string;
			translationDomain: TranslationDomain;
			requestId?: number;
		}): Promise<{
			success: boolean;
			result?: {
				content: string;
			}[];
		}> => {
			const config = supportedTranslationTypesRef.current.find(
				(item) => item.type === params.translationType,
			);

			if (!config || typeof config.type !== "string") {
				return {
					success: false,
				};
			}

			if ("translationApiConfig" in config) {
				const apiConfig = config.translationApiConfig;

				if (apiConfig.api_type === TranslationApiType.DeepL) {
					setStartTranslateLoading(true);

					let result: DeepLTranslateResult | undefined;
					try {
						result = await translateTextDeepL(
							apiConfig.api_uri,
							apiConfig.api_key,
							params.sourceContent,
							convertLanguageCodeToDeepLSourceLanguageCode(
								params.sourceLanguage,
							),
							convertLanguageCodeToDeepLTargetLanguageCode(
								params.targetLanguage,
							),
							apiConfig.deepl_prefer_quality_optimized ?? false,
						);
					} catch (error) {
						appError("[customTranslation] translateTextDeepL error", error);
					}

					setStartTranslateLoading(false);

					if (!result) {
						return {
							success: false,
						};
					}

					const deeplTranslatedResults = result.translations.map((item) => ({
						content: item.text,
					}));

					options?.onComplete?.(deeplTranslatedResults, params.requestId);
					setTranslatedContent(
						deeplTranslatedResults.map((item) => item.content).join("\n"),
					);

					return {
						success: true,
						result: deeplTranslatedResults,
					};
				}

				if (apiConfig.api_type === TranslationApiType.Custom) {
					setStartTranslateLoading(true);

					let result: Awaited<ReturnType<typeof translateTextCustomWithLimits>>;
					try {
						result = await translateTextCustomWithLimits(
							apiConfig,
							params.sourceContent,
							params.sourceLanguage,
							params.targetLanguage,
						);
					} catch (error) {
						appError("[customTranslation] translateTextCustom error", error);
					}

					setStartTranslateLoading(false);

					if (!result) {
						return {
							success: false,
						};
					}

					const customTranslatedResults = result.translations.map((item) => ({
						content: item.text,
					}));

					options?.onComplete?.(customTranslatedResults, params.requestId);
					setTranslatedContent(
						customTranslatedResults.map((item) => item.content).join("\n"),
					);

					return {
						success: true,
						result: customTranslatedResults,
					};
				}

				if (
					apiConfig.api_type === TranslationApiType.Youdao ||
					apiConfig.api_type === TranslationApiType.Tencent
				) {
					if (
						apiConfig.api_type === TranslationApiType.Tencent &&
						params.sourceLanguage === "auto"
					) {
						message.error(
							intl.formatMessage({
								id: "tools.translation.tencentAutoSourceNotSupported",
							}),
						);
						return {
							success: false,
						};
					}

					setStartTranslateLoading(true);

					let result: string[] | undefined;
					try {
						result = await translateText(
							toOnlineTranslationConfig(apiConfig),
							params.sourceContent,
							params.sourceLanguage,
							params.targetLanguage,
						);
					} catch (error) {
						appError("[customTranslation] translateText error", error);
					}

					setStartTranslateLoading(false);

					if (!result) {
						return {
							success: false,
						};
					}

					// 个别条目翻译失败时保持原文
					const translatedResults = result.map((content, index) => ({
						content: content || params.sourceContent[index] || "",
					}));

					options?.onComplete?.(translatedResults, params.requestId);
					setTranslatedContent(
						translatedResults.map((item) => item.content).join("\n"),
					);

					return {
						success: true,
						result: translatedResults,
					};
				}
			}

			if (!("apiConfig" in config)) {
				return {
					success: false,
				};
			}

			const client = new OpenAI({
				apiKey: config.apiConfig.api_key,
				baseURL: config.apiConfig.api_uri,
				dangerouslyAllowBrowser: true,
				fetch: appFetch,
			});

			setStartTranslateLoading(true);

			let responseContent: string = "";
			try {
				const streamResponse = await client.chat.completions.create({
					model: config.apiConfig.api_model.replace(CUSTOM_MODEL_PREFIX, ""),
					messages: [
						{
							role: "system",
							content: getTranslationPrompt(
								translationConfig?.translationSystemPrompt ??
									defaultTranslationPrompt,
								sourceLanguage,
								targetLanguage,
								translationDomain,
							),
						},
						{
							role: "user",
							content: params.sourceContent.join("%%"),
						},
					],
					max_completion_tokens: chatConfig?.maxTokens ?? 4096,
					temperature: chatConfig?.temperature ?? 1,
					stream: true,
				});

				setDeltaTranslateLoading(true);
				try {
					setTranslatedContent("");
					for await (const event of streamResponse) {
						if (event.choices.length > 0 && event.choices[0].delta.content) {
							setTranslatedContent(
								(prevContent) =>
									`${prevContent}${event.choices[0].delta.content}`,
							);
							responseContent += event.choices[0].delta.content;
							options?.onDeltaContent?.(event.choices[0].delta.content);
						}
					}
				} catch (error) {
					appError("[customTranslation] streamResponse error", error);
				}
				setDeltaTranslateLoading(false);
			} catch (error) {
				appError("[customTranslation] error", error);
			} finally {
				setStartTranslateLoading(false);
			}

			const result =
				params.sourceContent.length > 1
					? responseContent.split("%%").map((item) => ({ content: trim(item) }))
					: [{ content: responseContent }];

			options?.onComplete?.(result, params.requestId);

			return {
				success: true,
				result: [{ content: responseContent }],
			};
		},
		[
			sourceLanguage,
			targetLanguage,
			translationDomain,
			supportedTranslationTypesRef,
			chatConfig?.maxTokens,
			chatConfig?.temperature,
			options,
			translationConfig?.translationSystemPrompt,
			setTranslatedContent,
			intl,
			message,
		],
	);

	const requestTranslate = useCallback(
		async (sourceContent: string[], requestId?: number) => {
			const translationType = translationTypeRef.current;
			const translationDomain = translationDomainRef.current;
			const sourceLanguage = sourceLanguageRef.current;
			const targetLanguage = targetLanguageRef.current;

			if (options?.lazyLoad) {
				await reloadOnlineConfigs();
				await new Promise((resolve) => setTimeout(resolve, 17));
			}

			if (reloadOnlineConfigsPromiseRef.current) {
				await reloadOnlineConfigsPromiseRef.current;
				await new Promise((resolve) => setTimeout(resolve, 17));
			}

			if (typeof translationType === "string") {
				const result = await customTranslation({
					sourceContent: sourceContent,
					sourceLanguage: sourceLanguage,
					targetLanguage: targetLanguage,
					translationType: translationType,
					translationDomain: translationDomain,
					requestId: requestId,
				});
				if (result.success) {
					return;
				}
			}

			// 谷歌翻译
			if (translationType === TranslationType.Google) {
				setStartTranslateLoading(true);
				const result = await translateTextGoogle(
					sourceContent,
					sourceLanguage,
					targetLanguage,
				);
				setStartTranslateLoading(false);

				if (result) {
					const translatedResults = result.translations.map((item) => ({
						content: item.text,
					}));
					options?.onComplete?.(translatedResults, requestId);
					setTranslatedContent(
						translatedResults.map((item) => item.content).join("\n"),
					);
				}
				return;
			}

			// 微软翻译
			if (translationType === TranslationType.Microsoft) {
				setStartTranslateLoading(true);
				const result = await translateTextMicrosoft(
					sourceContent,
					sourceLanguage,
					targetLanguage,
				);
				setStartTranslateLoading(false);

				if (result) {
					const translatedResults = result.translations.map((item) => ({
						content: item.text,
					}));
					options?.onComplete?.(translatedResults, requestId);
					setTranslatedContent(
						translatedResults.map((item) => item.content).join("\n"),
					);
				}
				return;
			}

			setStartTranslateLoading(true);
			let translateResult:
				| ServiceResponse<TranslateData | undefined>
				| undefined;
			try {
				translateResult = await translate({
					content: sourceContent,
					from: sourceLanguage,
					to: targetLanguage,
					domain: translationDomain,
					type: translationType as TranslationType, // 如果没找到自定义模型，则报错
				});
			} catch (error) {
				appError("[requestTranslate] error", error);
				message.error("-1: Unknown error");
			}

			setStartTranslateLoading(false);

			if (
				!translateResult ||
				!translateResult.success() ||
				!translateResult.data?.results.length
			) {
				return;
			}

			options?.onComplete?.(translateResult.data?.results, requestId);
			setTranslatedContent(
				translateResult.data?.results.map((item) => item.content).join("\n") ??
					"",
			);
		},
		[
			customTranslation,
			options,
			sourceLanguageRef,
			message,
			targetLanguageRef,
			translationDomainRef,
			translationTypeRef,
			setTranslatedContent,
			reloadOnlineConfigs,
		],
	);

	const updateTranslationDomain = useCallback(
		(translationDomain: TranslationDomain) => {
			if (options?.enableCacheConfig) {
				updateAppSettings(
					AppSettingsGroup.FunctionTranslationCache,
					{ cacheTranslationDomain: translationDomain },
					true,
					true,
					false,
					true,
					false,
				);
			} else {
				updateAppSettings(
					AppSettingsGroup.FunctionTranslation,
					{ translationDomain },
					true,
					true,
					true,
					true,
					false,
				);
			}
		},
		[updateAppSettings, options?.enableCacheConfig],
	);

	const updateTranslationType = useCallback(
		(translationType: TranslationType | string) => {
			if (options?.enableCacheConfig) {
				updateAppSettings(
					AppSettingsGroup.FunctionTranslationCache,
					{ cacheTranslationType: translationType },
					true,
					true,
					false,
					true,
					false,
				);
			} else {
				updateAppSettings(
					AppSettingsGroup.FunctionTranslation,
					{ translationType },
					true,
					true,
					true,
					true,
					false,
				);
			}
		},
		[updateAppSettings, options?.enableCacheConfig],
	);

	const updateSourceLanguage = useCallback(
		(sourceLanguage: string) => {
			if (options?.enableCacheConfig) {
				updateAppSettings(
					AppSettingsGroup.FunctionTranslationCache,
					{ cacheSourceLanguage: sourceLanguage },
					true,
					true,
					false,
					true,
					false,
				);
			} else {
				updateAppSettings(
					AppSettingsGroup.FunctionTranslation,
					{ sourceLanguage },
					true,
					true,
					true,
					true,
					false,
				);
			}
		},
		[updateAppSettings, options?.enableCacheConfig],
	);

	const updateTargetLanguage = useCallback(
		(targetLanguage: string) => {
			if (options?.enableCacheConfig) {
				updateAppSettings(
					AppSettingsGroup.FunctionTranslationCache,
					{ cacheTargetLanguage: targetLanguage },
					true,
					true,
					false,
					true,
					false,
				);
			} else {
				updateAppSettings(
					AppSettingsGroup.FunctionTranslation,
					{ targetLanguage },
					true,
					true,
					true,
					true,
					false,
				);
			}
		},
		[updateAppSettings, options?.enableCacheConfig],
	);

	const getTranslatedContent = useCallback(() => {
		return translatedContentRef.current;
	}, [translatedContentRef]);

	return {
		updateTranslationDomain,
		updateTranslationType,
		updateSourceLanguage,
		updateTargetLanguage,
		requestTranslate,
		startTranslateLoading,
		deltaTranslateLoading,
		translatedContent,
		translationType,
		translationDomain,
		sourceLanguage,
		targetLanguage,
		supportedTranslationTypes,
		supportedTranslationTypesLoading,
		getTranslatedContent,
	};
};
