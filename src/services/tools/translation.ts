import type { CustomApiConfig } from "@/types/appSettings";
import type {
	DeepLTranslateResult,
	TranslateData,
	TranslateParams,
	TranslationTypeOption,
} from "@/types/servies/translation";
import { withCache } from "@/utils/cache";
import { ServiceResponse, serviceBaseFetch, serviceFetch } from ".";

export type CustomTranslateResult = {
	translations: {
		detected_source_lang: string;
		text: string;
	}[];
};

/**
 * 速率限制器 - 使用队列实现，按固定间隔处理请求
 */
class RateLimiter {
	private queue: Array<() => void> = [];
	private processing = false;
	private lastRequestTime = 0;

	constructor(private maxRequestsPerSecond: number) {}

	async acquire(): Promise<void> {
		return new Promise((resolve) => {
			this.queue.push(resolve);
			this.processQueue();
		});
	}

	private async processQueue(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;

		this.processing = true;

		while (this.queue.length > 0) {
			const now = Date.now();
			const minInterval = 1000 / this.maxRequestsPerSecond;
			const timeSinceLastRequest = now - this.lastRequestTime;

			if (timeSinceLastRequest < minInterval && this.lastRequestTime > 0) {
				await new Promise((r) =>
					setTimeout(r, minInterval - timeSinceLastRequest),
				);
			}

			const resolve = this.queue.shift();
			if (resolve) {
				this.lastRequestTime = Date.now();
				resolve();
			}
		}

		this.processing = false;
	}
}

// 存储每个 API URI 对应的速率限制器
const rateLimiters = new Map<string, RateLimiter>();

/**
 * 获取或创建速率限制器
 */
const getRateLimiter = (
	apiUri: string,
	maxRequestsPerSecond: number,
): RateLimiter => {
	let limiter = rateLimiters.get(apiUri);
	if (!limiter) {
		limiter = new RateLimiter(maxRequestsPerSecond);
		rateLimiters.set(apiUri, limiter);
	}
	return limiter;
};

/**
 * 根据 maxParagraphCount 拆分文本
 * 返回拆分后的文本块数组，每个块包含原始索引信息
 */
const splitTextForTranslation = (
	texts: string[],
	maxParagraphCount: number,
): Array<{ texts: string[]; originalIndices: number[] }> => {
	if (texts.length === 0) {
		return [];
	}

	const chunks: Array<{ texts: string[]; originalIndices: number[] }> = [];
	let currentChunk: string[] = [];
	let currentIndices: number[] = [];

	for (let i = 0; i < texts.length; i++) {
		// 检查是否需要开始新块
		if (currentChunk.length >= maxParagraphCount) {
			chunks.push({
				texts: currentChunk,
				originalIndices: currentIndices,
			});
			currentChunk = [];
			currentIndices = [];
		}

		currentChunk.push(texts[i]);
		currentIndices.push(i);
	}

	// 保存最后一块
	if (currentChunk.length > 0) {
		chunks.push({
			texts: currentChunk,
			originalIndices: currentIndices,
		});
	}

	return chunks;
};

export const translate = async (params: TranslateParams) => {
	return serviceFetch<TranslateData>("/api/v2/translation/translate", {
		method: "POST",
		data: params,
	});
};

export const getTranslationTypes = async () => {
	return serviceFetch<TranslationTypeOption[]>("/api/v2/translation/types", {
		method: "GET",
	});
};

const fetchTranslationTypes = async (): Promise<
	TranslationTypeOption[] | undefined
> => {
	const resp = await getTranslationTypes();
	if (resp.success()) {
		return resp.data ?? [];
	}
	return undefined;
};

export const getTranslationTypesWithCache = withCache(fetchTranslationTypes, {
	key: "getTranslationTypes",
	duration: 60 * 60 * 1000, // 缓存 1 小时
});

export const translateTextDeepL = async (
	apiUri: string,
	apiKey: string,
	sourceContent: string[],
	sourceLanguage: string | null,
	targetLanguage: string,
	preferQualityOptimized: boolean,
): Promise<DeepLTranslateResult | undefined> => {
	const response = await serviceBaseFetch(apiUri, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `DeepL-Auth-Key ${apiKey}`,
		},
		data: {
			text: sourceContent,
			source_lang: sourceLanguage,
			target_lang: targetLanguage,
			preserve_formatting: true,
			model_type: preferQualityOptimized
				? "prefer_quality_optimized"
				: "latency_optimized",
		},
	});

	if (response instanceof ServiceResponse) {
		response.success();
		return undefined;
	}

	return (await response.json()) as DeepLTranslateResult;
};

/**
 * 自定义翻译 API 语言代码映射
 */
const customLanguageCodeMap: Record<string, string> = {
	auto: "auto",
	"zh-CHS": "zh-CN",
	"zh-CHT": "zh-TW",
	en: "en",
	ja: "ja",
};

/**
 * 将语言代码转换为自定义翻译 API 支持的格式
 */
const convertToCustomLanguageCode = (lang: string): string => {
	return customLanguageCodeMap[lang] ?? lang;
};

/**
 * 单次翻译请求
 */
const translateTextCustomOnce = async (
	apiUri: string,
	sourceContent: string[],
	sourceLanguage: string,
	targetLanguage: string,
): Promise<CustomTranslateResult | undefined> => {
	const response = await serviceBaseFetch(apiUri, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		data: {
			source_lang: convertToCustomLanguageCode(sourceLanguage),
			target_lang: convertToCustomLanguageCode(targetLanguage),
			text_list: sourceContent,
		},
	});

	if (response instanceof ServiceResponse) {
		response.success();
		return undefined;
	}

	return (await response.json()) as CustomTranslateResult;
};

/**
 * 带速率限制和段落拆分的自定义翻译
 * 返回与输入数组对应的翻译结果（保持原始顺序）
 */
export const translateTextCustomWithLimits = async (
	config: CustomApiConfig,
	sourceContent: string[],
	sourceLanguage: string,
	targetLanguage: string,
): Promise<CustomTranslateResult | undefined> => {
	const maxRequestsPerSecond = config.max_requests_per_second ?? 5;
	const maxParagraphCount = config.max_paragraph_count ?? 1;

	const rateLimiter = getRateLimiter(config.api_uri, maxRequestsPerSecond);

	// 拆分文本
	const chunks = splitTextForTranslation(sourceContent, maxParagraphCount);

	if (chunks.length === 0) {
		return { translations: [] };
	}

	// 如果只有一个块，直接翻译
	if (chunks.length === 1) {
		await rateLimiter.acquire();
		return translateTextCustomOnce(
			config.api_uri,
			chunks[0].texts,
			sourceLanguage,
			targetLanguage,
		);
	}

	// 存储翻译结果，按原始索引
	const results: Array<{ text: string; detected_source_lang: string } | null> =
		new Array(sourceContent.length).fill(null);

	// 逐个处理每个块
	for (const chunk of chunks) {
		await rateLimiter.acquire();
		const result = await translateTextCustomOnce(
			config.api_uri,
			chunk.texts,
			sourceLanguage,
			targetLanguage,
		);

		if (result) {
			for (let j = 0; j < chunk.originalIndices.length; j++) {
				const originalIdx = chunk.originalIndices[j];
				const translation = result.translations[j];
				if (translation) {
					results[originalIdx] = translation;
				}
			}
		}
	}

	// 过滤掉 null 值并保持原始顺序
	const translations: CustomTranslateResult["translations"] = [];
	for (const result of results) {
		if (result) {
			translations.push(result);
		}
	}

	return { translations };
};

export const translateTextCustom = translateTextCustomOnce;

/**
 * 谷歌翻译语言代码映射
 */
const googleLanguageCodeMap: Record<string, string> = {
	auto: "auto",
	"zh-CHS": "zh-CN",
	"zh-CHT": "zh-TW",
	en: "en",
	ja: "ja",
};

/**
 * 微软翻译语言代码映射
 */
const microsoftLanguageCodeMap: Record<string, string> = {
	auto: "",
	"zh-CHS": "zh-Hans",
	"zh-CHT": "zh-Hant",
	en: "en",
	ja: "ja",
};

// 谷歌翻译速率限制器（每秒最多 5 个请求）
const googleRateLimiter = new RateLimiter(5);
// 微软翻译速率限制器（每秒最多 5 个请求）
const microsoftRateLimiter = new RateLimiter(5);

/**
 * 谷歌翻译
 */
export const translateTextGoogle = async (
	sourceContent: string[],
	sourceLanguage: string,
	targetLanguage: string,
): Promise<CustomTranslateResult | undefined> => {
	const sl = googleLanguageCodeMap[sourceLanguage] ?? sourceLanguage;
	const tl = googleLanguageCodeMap[targetLanguage] ?? targetLanguage;

	const translations: CustomTranslateResult["translations"] = [];

	for (const text of sourceContent) {
		await googleRateLimiter.acquire();

		try {
			const params = new URLSearchParams({
				client: "gtx",
				sl: sl === "auto" ? "auto" : sl,
				tl,
				dt: "t",
				q: text,
			});

			const response = await fetch(
				`https://translate.googleapis.com/translate_a/single?${params.toString()}`,
				{
					method: "GET",
				},
			);

			if (!response.ok) {
				console.error(
					"[translateTextGoogle] HTTP error:",
					response.status,
					response.statusText,
				);
				continue;
			}

			const data = await response.json();
			// 谷歌翻译返回格式: [[["翻译文本", "原文", null, null, 10], ...], null, "检测到的语言", ...]
			const translatedText = Array.isArray(data?.[0])
				? data[0].map((item: string[]) => item?.[0] ?? "").join("")
				: "";
			const detectedLang = data?.[2] ?? sourceLanguage;

			translations.push({
				text: translatedText,
				detected_source_lang: detectedLang,
			});
		} catch (error) {
			console.error("[translateTextGoogle] error", error);
		}
	}

	return translations.length > 0 ? { translations } : undefined;
};

/**
 * 微软翻译 (Bing Translator)
 */
export const translateTextMicrosoft = async (
	sourceContent: string[],
	sourceLanguage: string,
	targetLanguage: string,
): Promise<CustomTranslateResult | undefined> => {
	// 微软翻译语言代码映射
	const sl = microsoftLanguageCodeMap[sourceLanguage] ?? sourceLanguage;
	const tl = microsoftLanguageCodeMap[targetLanguage] ?? targetLanguage;

	const translations: CustomTranslateResult["translations"] = [];

	for (const text of sourceContent) {
		await microsoftRateLimiter.acquire();

		try {
			const params = new URLSearchParams({ to: tl });
			// 未指定源语言（auto）时省略 from 参数，由端点自动检测
			if (sl) {
				params.set("from", sl);
			}

			const response = await fetch(
				`https://edge.microsoft.com/translate/translatetext?${params.toString()}`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
						Origin: "https://www.microsoft.com",
						Referer: "https://www.microsoft.com/",
					},
					body: JSON.stringify([text]),
				},
			);

			if (!response.ok) {
				console.error(
					"[translateTextMicrosoft] HTTP error:",
					response.status,
					response.statusText,
				);
				continue;
			}

			const data = await response.json();
			// 微软翻译返回格式: [{"detectedLanguage":{"language":"en"},"translations":[{"text":"翻译文本","to":"zh-Hans"}]}]
			const result = data?.[0];
			const translatedText = result?.translations?.[0]?.text ?? "";
			const detectedLang = result?.detectedLanguage?.language ?? sourceLanguage;

			translations.push({
				text: translatedText,
				detected_source_lang: detectedLang,
			});
		} catch (error) {
			console.error("[translateTextMicrosoft] error", error);
		}
	}

	return translations.length > 0 ? { translations } : undefined;
};
