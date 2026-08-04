"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { theme } from "antd";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { setCurrentWindowAlwaysOnTop } from "@/commands/core";
import { listenKeyStart, listenKeyStop } from "@/commands/listenKey";
import { EventListenerContext } from "@/components/eventListener";
import {
	LISTEN_KEY_SERVICE_KEY_DOWN_EMIT_KEY,
	LISTEN_KEY_SERVICE_KEY_UP_EMIT_KEY,
} from "@/constants/eventListener";
import { PLUGIN_ID_FFMPEG } from "@/constants/pluginService";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { useStateRef } from "@/hooks/useStateRef";
import { AppSettingsGroup } from "@/types/appSettings";
import type { ListenKeyDownEvent } from "@/types/commands/listenKey";
import type { ElementRect } from "@/types/commands/screenshot";
import { appError, appInfo } from "@/utils/log";
import { getPlatform } from "@/utils/platform";
import type { VideoRecordWindowInfo } from "@/utils/types";
import { setWindowRect } from "@/utils/window";
import { getVideoRecordParams, VideoRecordState } from "./extra";

const PENDING_STROKE_COLOR = "#4096ff";
const RECORDING_STROKE_COLOR = "#f5222d";
const PAUSED_STROKE_COLOR = "#faad14";
const BORDER_WIDTH = 2;
const BORDER_PADDING = 8;

interface KeyDisplayItem {
	id: number;
	text: string;
	timestamp: number;
	timerId?: NodeJS.Timeout;
	// 是否为原子组合（包含修饰键的组合或其它需要立即终止合并的条目）
	atomic?: boolean;
}

export const VideoRecordPage: React.FC = () => {
	const { token } = theme.useToken();
	const selectCanvasRef = useRef<HTMLDivElement>(null);

	const selectRectRef = useRef<ElementRect | undefined>(undefined);

	const { addListener, removeListener } = useContext(EventListenerContext);

	const [videoRecordState, setVideoRecordState, videoRecordStateRef] =
		useStateRef(VideoRecordState.Idle);

	// 按键显示相关状态
	const [keyDisplayList, setKeyDisplayList] = useState<KeyDisplayItem[]>([]);
	const keyIdCounterRef = useRef(0);

	// 组合键判定相关
	const pendingModifiersRef = useRef<Set<string>>(new Set());
	const pendingModifierTimerRef = useRef<NodeJS.Timeout | null>(null);
	const lastKeydownAtRef = useRef<Map<string, number>>(new Map());

	// 平台
	const platform = getPlatform();

	// 规范化按键显示
	const normalizeKeyText = useCallback(
		(keyTextRaw: string): { display: string; isModifier: boolean } => {
			const raw = keyTextRaw || "";
			const isMac = platform === "macos";
			// 左右键统一
			if (/(L|R)?Control/i.test(raw) || /^Ctrl$/i.test(raw)) {
				return { display: "Ctrl", isModifier: true };
			}
			if (/(L|R)?Shift/i.test(raw) || /^Shift$/i.test(raw)) {
				return { display: "Shift", isModifier: true };
			}
			if (
				/(L|R)?Alt/i.test(raw) ||
				/(L|R)?Option/i.test(raw) ||
				/^Alt$/i.test(raw)
			) {
				return { display: isMac ? "Option" : "Alt", isModifier: true };
			}
			if (
				/(L|R)?Meta/i.test(raw) ||
				/Command/i.test(raw) ||
				/^Cmd$/i.test(raw) ||
				/^Win$/i.test(raw)
			) {
				return { display: isMac ? "Cmd" : "Win", isModifier: true };
			}
			// 其它常用功能键统一命名
			if (/^Escape$/i.test(raw) || /^Esc$/i.test(raw))
				return { display: "Esc", isModifier: false };
			if (/^Enter$/i.test(raw) || /^Return$/i.test(raw))
				return { display: "Enter", isModifier: false };
			if (/^Space$/i.test(raw) || /^Spacebar$/i.test(raw))
				return { display: "Space", isModifier: false };
			if (/^Tab$/i.test(raw)) return { display: "Tab", isModifier: false };
			if (/^Backspace$/i.test(raw))
				return { display: "Backspace", isModifier: false };
			if (/^CapsLock$/i.test(raw))
				return { display: "CapsLock", isModifier: false };
			if (/^Arrow(Up|Down|Left|Right)$/i.test(raw))
				return { display: raw.replace(/^Arrow/, ""), isModifier: false };
			if (/^F([1-9]|1[0-2]|1[3-9]|2[0-4])$/i.test(raw))
				return { display: raw.toUpperCase(), isModifier: false };
			// 默认：字母转大写，其它保持
			if (/^[a-z]$/.test(raw))
				return { display: raw.toUpperCase(), isModifier: false };
			return { display: raw, isModifier: false };
		},
		[platform],
	);

	const sortModifiers = useCallback(
		(mods: string[]): string[] => {
			const order =
				platform === "macos"
					? [
							"Cmd",
							"Ctrl",
							platform === "macos" ? "Option" : "Alt",
							"Shift",
							"Win",
						]
					: ["Ctrl", "Alt", "Shift", "Win", "Cmd"];
			return [...mods].sort((a, b) => order.indexOf(a) - order.indexOf(b));
		},
		[platform],
	);

	const REPEAT_SUPPRESS_MS = 50; // 抑制按住导致的重复 keydown
	const MODIFIER_ALONE_DELAY_MS = 200; // 修饰键独显延迟

	// 按键显示配置
	const [keyDisplayConfig, setKeyDisplayConfig] = useState({
		enableKeyDisplay: true,
		fontSize: 16,
		backgroundColor: "rgba(0, 0, 0, 0.7)",
		textColor: "#ffffff",
		duration: 3000,
		mergeDuration: 256,
		direction: "horizontal" as "horizontal" | "vertical",
	});

	// 加载配置
	useAppSettingsLoad((settings) => {
		const videoRecordSettings = settings[AppSettingsGroup.FunctionVideoRecord];
		setKeyDisplayConfig({
			enableKeyDisplay: videoRecordSettings.enableKeyDisplay,
			fontSize: videoRecordSettings.keyDisplayFontSize,
			backgroundColor: videoRecordSettings.keyDisplayBackgroundColor,
			textColor: videoRecordSettings.keyDisplayTextColor,
			duration: videoRecordSettings.keyDisplayDuration,
			mergeDuration: videoRecordSettings.keyDisplayMergeDuration,
			direction: videoRecordSettings.keyDisplayDirection,
		});
	}, true);

	const drawSelectRect = useCallback((videoRecordState: VideoRecordState) => {
		const canvas = selectCanvasRef.current;
		if (!canvas) {
			return;
		}

		// 绘制选择区域的矩形边框
		const rect = selectRectRef.current;
		if (rect) {
			let strokeColor = PENDING_STROKE_COLOR;
			if (videoRecordState === VideoRecordState.Recording) {
				strokeColor = RECORDING_STROKE_COLOR;
			} else if (videoRecordState === VideoRecordState.Paused) {
				strokeColor = PAUSED_STROKE_COLOR;
			}

			canvas.style.borderColor = strokeColor;
		}
	}, []);

	const init = useCallback(
		async (selectRect: ElementRect) => {
			appInfo("[DIAG] videoRecord init: start", {
				selectRect,
				state: videoRecordStateRef.current,
			});
			if (videoRecordStateRef.current !== VideoRecordState.Idle) {
				appInfo("[DIAG] videoRecord init: not idle, skipping");
				return;
			}

			selectRectRef.current = selectRect;

			const appWindow = getCurrentWindow();

			const windowWidth =
				selectRect.max_x - selectRect.min_x + BORDER_WIDTH + BORDER_PADDING * 2;
			const windowHeight =
				selectRect.max_y - selectRect.min_y + BORDER_WIDTH + BORDER_PADDING * 2;
			const windowX = selectRect.min_x - BORDER_WIDTH / 2 - BORDER_PADDING;
			const windowY = selectRect.min_y - BORDER_WIDTH / 2 - BORDER_PADDING;

			appInfo("[DIAG] videoRecord init: setting window rect", {
				windowX, windowY, windowWidth, windowHeight,
			});
			await Promise.all([
				setWindowRect(appWindow, {
					min_x: windowX,
					min_y: windowY,
					max_x: windowX + windowWidth,
					max_y: windowY + windowHeight,
				}),
				setCurrentWindowAlwaysOnTop(true),
			]);

			appInfo("[DIAG] videoRecord init: showing window");
			await appWindow.show();

			setVideoRecordState(VideoRecordState.Idle);
			drawSelectRect(VideoRecordState.Idle);

			appWindow.setIgnoreCursorEvents(true);
			appInfo("[DIAG] videoRecord init: done");
		},
		[drawSelectRect, setVideoRecordState, videoRecordStateRef],
	);

	useEffect(() => {
		drawSelectRect(videoRecordState);

		if (videoRecordState === VideoRecordState.Recording) {
			listenKeyStart(true).catch((error) => {
				appError("[VideoRecordPage] listenKeyStart error", error);
			});
		} else {
			listenKeyStop(true).catch((error) => {
				appError("[VideoRecordPage] listenKeyStop error", error);
			});
		}
	}, [drawSelectRect, videoRecordState]);

	useEffect(() => {
		const appWindow = getCurrentWindow();
		const unlisten = appWindow.onCloseRequested(async () => {
			await listenKeyStop(true).catch((error) => {
				appError(
					"[VideoRecordPage] onCloseRequested listenKeyStop error",
					error,
				);
			});
		});

		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	useEffect(() => {
		const keyDownListenerId = addListener(
			LISTEN_KEY_SERVICE_KEY_DOWN_EMIT_KEY,
			(params) => {
				const { key_text } = (params as { payload: ListenKeyDownEvent })
					.payload;

				const now = Date.now();
				const { display, isModifier } = normalizeKeyText(key_text);

				// 抑制按住导致的重复 keydown
				const lastAt = lastKeydownAtRef.current.get(display) ?? 0;
				if (now - lastAt < REPEAT_SUPPRESS_MS) {
					return;
				}
				lastKeydownAtRef.current.set(display, now);

				if (isModifier) {
					// 记录修饰键，等待组合
					pendingModifiersRef.current.add(display);
					// 延迟显示仅修饰键（若短时间内未有非修饰键跟随）
					if (pendingModifierTimerRef.current) {
						clearTimeout(pendingModifierTimerRef.current);
					}
					pendingModifierTimerRef.current = setTimeout(() => {
						const mods = Array.from(pendingModifiersRef.current);
						if (mods.length === 0) return;
						const text = sortModifiers(mods).join("+");
						const keyId = keyIdCounterRef.current++;
						const timerId = setTimeout(() => {
							setKeyDisplayList((list) =>
								list.filter((item) => item.id !== keyId),
							);
						}, keyDisplayConfig.duration);
						setKeyDisplayList((prev) => [
							...prev,
							{ id: keyId, text, timestamp: Date.now(), timerId, atomic: true },
						]);
					}, MODIFIER_ALONE_DELAY_MS);
					return;
				}

				// 非修饰键
				const mods = Array.from(pendingModifiersRef.current);
				if (mods.length > 0) {
					// 存在修饰键：立即生成原子组合，终止合并
					if (pendingModifierTimerRef.current) {
						clearTimeout(pendingModifierTimerRef.current);
						pendingModifierTimerRef.current = null;
					}
					const text = `${sortModifiers(mods).join("+")}+${display}`;
					pendingModifiersRef.current.clear();

					const keyId = keyIdCounterRef.current++;
					const timerId = setTimeout(() => {
						setKeyDisplayList((list) =>
							list.filter((item) => item.id !== keyId),
						);
					}, keyDisplayConfig.duration);
					setKeyDisplayList((prev) => [
						...prev,
						{ id: keyId, text, timestamp: now, timerId, atomic: true },
					]);
					return;
				}

				// 无修饰键：按原逻辑合并，但若上一条为原子组合则不合并
				setKeyDisplayList((prevList) => {
					if (prevList.length === 0) {
						const keyId = keyIdCounterRef.current++;
						const timerId = setTimeout(() => {
							setKeyDisplayList((list) =>
								list.filter((item) => item.id !== keyId),
							);
						}, keyDisplayConfig.duration);
						return [{ id: keyId, text: display, timestamp: now, timerId }];
					}

					const lastKey = prevList[prevList.length - 1];
					const timeDiff = now - lastKey.timestamp;

					if (!lastKey.atomic && timeDiff < keyDisplayConfig.mergeDuration) {
						// 不重复追加相同键
						const parts = lastKey.text.split("+");
						const lastPart = parts[parts.length - 1];
						if (lastPart === display) {
							return prevList; // 忽略重复
						}

						if (lastKey.timerId) {
							clearTimeout(lastKey.timerId);
						}
						const newTimerId = setTimeout(() => {
							setKeyDisplayList((list) =>
								list.filter((item) => item.id !== lastKey.id),
							);
						}, keyDisplayConfig.duration);

						return prevList.map((item, index) => {
							if (index === prevList.length - 1) {
								return {
									...item,
									text: `${item.text}+${display}`,
									timestamp: now,
									timerId: newTimerId,
								};
							}
							return item;
						});
					}

					const keyId = keyIdCounterRef.current++;
					const timerId = setTimeout(() => {
						setKeyDisplayList((list) =>
							list.filter((item) => item.id !== keyId),
						);
					}, keyDisplayConfig.duration);
					return [
						...prevList,
						{ id: keyId, text: display, timestamp: now, timerId },
					];
				});
			},
		);

		return () => {
			removeListener(keyDownListenerId);
			if (pendingModifierTimerRef.current) {
				clearTimeout(pendingModifierTimerRef.current);
				pendingModifierTimerRef.current = null;
			}
			pendingModifiersRef.current.clear();
		};
	}, [
		addListener,
		removeListener,
		normalizeKeyText,
		sortModifiers,
		keyDisplayConfig.duration,
		keyDisplayConfig.mergeDuration,
	]);

	// 监听 key up，用于清理修饰键集合
	useEffect(() => {
		const keyUpListenerId = addListener(
			LISTEN_KEY_SERVICE_KEY_UP_EMIT_KEY,
			(params) => {
				const { key_text } = (params as { payload: ListenKeyDownEvent })
					.payload;
				const { display, isModifier } = normalizeKeyText(key_text);
				if (!isModifier) return;
				pendingModifiersRef.current.delete(display);
				if (
					pendingModifiersRef.current.size === 0 &&
					pendingModifierTimerRef.current
				) {
					clearTimeout(pendingModifierTimerRef.current);
					pendingModifierTimerRef.current = null;
				}
			},
		);

		return () => {
			removeListener(keyUpListenerId);
		};
	}, [addListener, removeListener, normalizeKeyText]);

	useEffect(() => {
		const { selectRect } = getVideoRecordParams();
		init(selectRect);

		const listenerId = addListener("reload-video-record", (params) => {
			const windowInfo = (params as { payload: VideoRecordWindowInfo }).payload;

			init({
				min_x: windowInfo.select_rect_min_x,
				min_y: windowInfo.select_rect_min_y,
				max_x: windowInfo.select_rect_max_x,
				max_y: windowInfo.select_rect_max_y,
			});
		});

		const changeVideoRecordStateListenerId = addListener(
			"change-video-record-state",
			(params) => {
				const { state } = (params as { payload: { state: VideoRecordState } })
					.payload;

				setVideoRecordState(state);
			},
		);

		return () => {
			removeListener(listenerId);
			removeListener(changeVideoRecordStateListenerId);
		};
	}, [addListener, init, removeListener, setVideoRecordState]);

	const { isReadyStatus } = usePluginServiceContext();

	useEffect(() => {
		if (!isReadyStatus) {
			return;
		}

		if (!isReadyStatus(PLUGIN_ID_FFMPEG)) {
			getCurrentWindow().close();
		}
	}, [isReadyStatus]);

	return (
		<div className="container" onContextMenu={(e) => e.preventDefault()}>
			<div ref={selectCanvasRef} className="select-canvas" />

			{/* 按键显示区域 */}
			{keyDisplayConfig.enableKeyDisplay && (
				<div className="key-display-container">
					{keyDisplayList.map((keyItem) => (
						<div key={keyItem.id} className="key-display-item">
							{keyItem.text}
						</div>
					))}
				</div>
			)}

			<style jsx>{`
                .container {
                    width: 100vw;
                    height: 100vh;
                    overflow: hidden;
                    padding: ${BORDER_WIDTH}px;
                    box-sizing: border-box;
                }

                .select-canvas {
                    position: absolute;
                    box-sizing: border-box;
                    border-width: ${BORDER_WIDTH}px;
                    border-style: solid;
                    width: calc(100% - ${BORDER_WIDTH * 2}px);
                    height: calc(100% - ${BORDER_WIDTH * 2}px);
                }

                .key-display-container {
                    position: fixed;
                    bottom: ${token.margin - token.paddingLG}px;
                    right: ${token.margin - token.paddingLG}px;
                    display: flex;
                    flex-direction: ${keyDisplayConfig.direction === "horizontal" ? "row" : "column"};
                    align-items: ${keyDisplayConfig.direction === "horizontal" ? "center" : "flex-end"};
                    justify-content: flex-end;
                    gap: ${token.marginXS}px;
                    pointer-events: none;
                    max-width: ${keyDisplayConfig.direction === "horizontal" ? `calc(90vw - ${token.margin * 2}px)` : "auto"};
                    max-height: ${keyDisplayConfig.direction === "vertical" ? `calc(90vh - ${token.margin * 2}px)` : "auto"};
                    overflow-x: ${keyDisplayConfig.direction === "horizontal" ? "hidden" : "visible"};
                    overflow-y: ${keyDisplayConfig.direction === "vertical" ? "hidden" : "visible"};
                    padding: ${token.paddingLG}px ${token.paddingLG}px;
                }

                .key-display-item {
                    background: ${keyDisplayConfig.backgroundColor};
                    color: ${keyDisplayConfig.textColor};
                    padding: ${token.paddingXXS}px ${token.padding}px;
                    border-radius: ${token.borderRadius}px;
                    font-size: ${keyDisplayConfig.fontSize}px;
                    font-weight: ${token.fontWeightStrong};
                    box-shadow: ${token.boxShadowSecondary};
                    animation: keyFadeIn 0.1s ease-out;
                    text-align: center;
                    flex-shrink: 0;
                    white-space: nowrap;
                }

                @keyframes keyFadeIn {
                    from {
                        opacity: 0;
                        transform: translateY(${token.fontSizeLG}px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }
            `}</style>
		</div>
	);
};
