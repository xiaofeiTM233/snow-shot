"use client";

import { useSearch } from "@tanstack/react-router";
import { theme } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { FormattedMessage } from "react-intl";
import { ContentWrap } from "@/components/contentWrap";
import { HotkeysMenu } from "@/components/hotkeysMenu";
import { Translator, type TranslatorActionType } from "@/components/translator";
import { finishScreenshot } from "@/functions/screenshot";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { AppSettingsGroup } from "@/types/appSettings";
import {
	CommonKeyEventKey,
	type CommonKeyEventValue,
} from "@/types/core/commonKeyEvent";
import { decodeParamsValue } from "@/utils/base64";
import { copyText, copyTextAndHide } from "@/utils/clipboard";
import { formatKey } from "@/utils/format";

export const TranslationCore = ({
	searchParamsSign,
	searchParamsSelectText,
}: {
	searchParamsSign?: string;
	searchParamsSelectText?: string;
}) => {
	const { token } = theme.useToken();

	const translatorActionRef = useRef<TranslatorActionType>(undefined);

	const prevSearchParamsSign = useRef<string | undefined>(undefined);
	const ignoreDebounce = useRef<boolean>(false);
	const updateSourceContentBySelectedText = useCallback(async () => {
		if (prevSearchParamsSign.current === searchParamsSign) {
			return;
		}

		prevSearchParamsSign.current = searchParamsSign;

		if (searchParamsSelectText) {
			await finishScreenshot();

			translatorActionRef.current?.setSourceContent(
				decodeParamsValue(searchParamsSelectText).substring(0, 5000),
				true,
			);
			ignoreDebounce.current = true;
		}

		setTimeout(() => {
			translatorActionRef.current?.getSourceContentRef()?.focus();
			prevSearchParamsSign.current = searchParamsSign;
		}, 64);
	}, [searchParamsSign, searchParamsSelectText]);

	useEffect(() => {
		updateSourceContentBySelectedText();
	}, [updateSourceContentBySelectedText]);

	const [hotKeys, setHotKeys] =
		useState<Record<CommonKeyEventKey, CommonKeyEventValue>>();
	useAppSettingsLoad(
		useCallback((appSettings) => {
			setHotKeys(appSettings[AppSettingsGroup.CommonKeyEvent]);
		}, []),
		true,
	);

	const onCopy = useCallback(() => {
		if (!translatorActionRef.current) {
			return;
		}

		copyText(
			translatorActionRef.current
				.getTranslatedContent()
				.map((item) => item.content)
				.join("\n"),
		);
	}, []);
	const onCopyAndHide = useCallback(() => {
		if (!translatorActionRef.current) {
			return;
		}

		copyTextAndHide(
			translatorActionRef.current
				.getTranslatedContent()
				.map((item) => item.content)
				.join("\n"),
		);
	}, []);

	useHotkeys(
		hotKeys?.[CommonKeyEventKey.CopyAndHide]?.hotKey ?? "",
		onCopyAndHide,
		{
			keyup: false,
			keydown: true,
			preventDefault: true,
			enableOnFormTags: ["INPUT", "TEXTAREA", "SELECT"],
		},
	);
	useHotkeys(hotKeys?.[CommonKeyEventKey.Copy]?.hotKey ?? "", onCopy, {
		keyup: false,
		keydown: true,
		preventDefault: true,
		enableOnFormTags: ["INPUT", "TEXTAREA", "SELECT"],
	});

	return (
		<>
			<ContentWrap className="settings-wrap">
				<Translator actionRef={translatorActionRef} />

				<HotkeysMenu
					className="translation-hotkeys-menu"
					menu={{
						items: [
							{
								label: (
									<FormattedMessage
										id="settings.hotKeySettings.keyEventTooltip"
										values={{
											message: <FormattedMessage id="tools.translation.copy" />,
											key: formatKey(hotKeys?.[CommonKeyEventKey.Copy]?.hotKey),
										}}
									/>
								),
								key: "copy",
								onClick: onCopy,
							},
							{
								label: (
									<FormattedMessage
										id="settings.hotKeySettings.keyEventTooltip"
										values={{
											message: (
												<FormattedMessage id="tools.translation.copyAndHide" />
											),
											key: formatKey(
												hotKeys?.[CommonKeyEventKey.CopyAndHide]?.hotKey,
											),
										}}
									/>
								),
								key: "copyAndHide",
								onClick: onCopyAndHide,
							},
						],
					}}
				/>
			</ContentWrap>

			<style jsx>{`
                :global(.translation-hotkeys-menu) {
                    position: fixed;
                    bottom: 0;
                    right: 0;
                    padding: ${token.padding}px;
                }
            `}</style>
		</>
	);
};

export const TranslationPage = () => {
	const searchParams = useSearch({ from: "/_layout/tools/translation" }) as {
		t?: string;
		selectText?: string;
	};
	return (
		<TranslationCore
			searchParamsSign={searchParams.t}
			searchParamsSelectText={searchParams.selectText}
		/>
	);
};
