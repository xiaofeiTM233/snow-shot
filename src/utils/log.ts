import * as tauriLog from "@tauri-apps/plugin-log";

/**
 * 将各种类型的错误对象格式化为字符串和详细信息
 * @param error 错误对象，可以是 Error、string、object 等
 * @returns 包含格式化字符串和详细信息的对象
 */
export const formatErrorDetails = (
	error: unknown,
): { message: string; details: Record<string, unknown> } => {
	try {
		const details: Record<string, unknown> = {};

		if (!error) {
			return { message: "Unknown error", details };
		}

		if (error instanceof Error) {
			details.stack = error.stack;
			details.name = error.name;
			details.message = error.message;
			return { message: `${error.name}: ${error.message}`, details };
		}

		if (typeof error === "string") {
			return { message: error, details };
		}

		if (typeof error === "object") {
			const errorObj = error as Record<string, unknown>;

			// 提取可能的错误属性
			if ("stack" in errorObj) {
				details.stack = errorObj.stack;
			}
			if ("name" in errorObj) {
				details.name = errorObj.name;
			}
			if ("message" in errorObj && typeof errorObj.message === "string") {
				details.message = errorObj.message;
				const name =
					"name" in errorObj && typeof errorObj.name === "string"
						? errorObj.name
						: "Error";
				return { message: `${name}: ${errorObj.message}`, details };
			}

			// 尝试 JSON 序列化以获取完整信息
			try {
				details.fullObject = JSON.stringify(
					error,
					Object.getOwnPropertyNames(error),
				);
				return { message: `Object: ${details.fullObject}`, details };
			} catch {
				details.type = error.constructor?.name || "unknown";
				return { message: `Object (${details.type})`, details };
			}
		}

		// 对于其他类型，转换为字符串
		return { message: String(error), details };
	} catch {
		return { message: "Format error details failed", details: {} };
	}
};

/**
 * 格式化额外信息，确保换行符正确显示
 */
function formatExtraInfo(extra: unknown): string {
	if (!extra) return "";

	if (typeof extra === "string") {
		return extra;
	}

	if (typeof extra === "object") {
		try {
			const obj = extra as Record<string, unknown>;
			const parts: string[] = [];

			for (const [key, value] of Object.entries(obj)) {
				if (key === "stack" && typeof value === "string") {
					// 堆栈信息压缩成单行，避免日志被拆成多行
					parts.push(`${key}: ${value.replace(/\s*\n\s*/g, " ")}`);
				} else if (typeof value === "string" && value.includes("\n")) {
					// 其他包含换行符的字符串同样压缩成单行
					parts.push(`${key}: ${value.replace(/\s*\n\s*/g, " ")}`);
				} else {
					// 其他值使用 JSON.stringify
					parts.push(`${key}: ${JSON.stringify(value)}`);
				}
			}

			return ` ${parts.join(", ")}`;
		} catch {
			return " [无法序列化额外信息]";
		}
	}

	return String(extra);
}

export function appError(
	message: string,
	extra?: unknown,
	options?: tauriLog.LogOptions,
) {
	const extraInfo = formatExtraInfo(extra);
	tauriLog.error(`[${location.href}] ${message}${extraInfo}`, options);
}

export function appWarn(
	message: string,
	extra?: unknown,
	options?: tauriLog.LogOptions,
) {
	const extraInfo = formatExtraInfo(extra);
	tauriLog.warn(`[${location.href}] ${message}${extraInfo}`, options);
}

export function appInfo(
	message: string,
	extra?: unknown,
	options?: tauriLog.LogOptions,
) {
	const extraInfo = formatExtraInfo(extra);
	tauriLog.info(`[${location.href}] ${message}${extraInfo}`, options);
}

export function appDebug(
	message: string,
	extra?: unknown,
	options?: tauriLog.LogOptions,
) {
	const extraInfo = formatExtraInfo(extra);
	tauriLog.debug(`[${location.href}] ${message}${extraInfo}`, options);
}
