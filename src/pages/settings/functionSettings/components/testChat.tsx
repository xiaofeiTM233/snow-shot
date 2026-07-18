import { ModalForm } from "@ant-design/pro-components";
import { Alert, Spin, theme } from "antd";
import OpenAI from "openai";
import type React from "react";
import { useCallback, useState } from "react";
import { FormattedMessage } from "react-intl";
import { TestChatIcon } from "@/components/icons";
import { AppSettingsPublisher } from "@/contexts/appSettingsActionContext";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { appFetch } from "@/services/tools";
import { AppSettingsGroup, type ChatApiConfig } from "@/types/appSettings";
import { appError } from "@/utils/log";

export const TestChat: React.FC<{ config: ChatApiConfig }> = ({ config }) => {
	const { token } = theme.useToken();
	const [result, setResult] = useState("");
	const [loading, setLoading] = useState(false);

	const [getAppSettings] = useStateSubscriber(AppSettingsPublisher, undefined);

	const handleTest = useCallback(async () => {
		setLoading(true);
		setResult("");
		try {
			const client = new OpenAI({
				apiKey: config.api_key,
				baseURL: config.api_uri,
				dangerouslyAllowBrowser: true,
				fetch: appFetch,
			});

			const stream_response = await client.chat.completions.create({
				model: config.api_model,
				messages: [{ role: "user", content: 'Say "Hello, world!"' }],
				stream: true,
				max_completion_tokens: 4096,
				temperature: getAppSettings()[AppSettingsGroup.SystemChat].temperature,
			});

			for await (const event of stream_response) {
				if (event.choices.length > 0 && event.choices[0].delta.content) {
					setResult((prev) => `${prev}${event.choices[0].delta.content}`);
				}
			}
		} catch (error) {
			appError("[handleTest] error", error);
		}

		setLoading(false);
	}, [config.api_key, config.api_model, config.api_uri, getAppSettings]);

	return (
		<ModalForm
			title="Test Chat"
			trigger={
				<span
					onClick={handleTest}
					className="anticon ant-pro-form-list-action-icon"
				>
					<TestChatIcon />
				</span>
			}
			onFinish={async () => {
				return true;
			}}
		>
			<Alert
				type="info"
				message={
					<FormattedMessage
						id="settings.functionSettings.chatSettings.testPrompt"
						values={{
							prompt: '"Say "Hello, world!""',
						}}
					/>
				}
				style={{ marginBottom: token.margin }}
			/>
			<Spin spinning={loading}>
				<div style={{ display: "inline-block" }}>{result}</div>
			</Spin>
		</ModalForm>
	);
};
