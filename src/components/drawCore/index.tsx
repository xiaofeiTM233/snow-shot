"use client";

import type {
	AppState,
	ExcalidrawActionType,
	ExcalidrawImperativeAPI,
	ExcalidrawInitialDataState,
	ExcalidrawProps,
	ExcalidrawPropsCustomOptions,
	ToolType,
} from "@mg-chao/excalidraw/types";
import React, {
	lazy,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
} from "react";
import "@mg-chao/excalidraw/index.css";
import type { ExcalidrawElement } from "@mg-chao/excalidraw/element/types";
import { theme } from "antd";
import { debounce } from "es-toolkit";
import { useIntl } from "react-intl";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { usePlatform } from "@/hooks/usePlatform";
import { withStatePublisher } from "@/hooks/useStatePublisher";
import { useStateRef } from "@/hooks/useStateRef";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { AppSettingsGroup } from "@/types/appSettings";
import type { ElementRect } from "@/types/commands/screenshot";
import { DrawState } from "@/types/draw";
import { ExcalidrawAppStateStore } from "@/utils/appStore";
import { appWarn } from "@/utils/log";
import { getExcalidrawCanvas } from "@/utils/excalidraw";
import { ExcalidrawKeyEventHandler } from "./components/excalidrawKeyEventHandler";
import { useHistory } from "./components/historyContext";
import {
	SerialNumberContextProvider,
	SerialNumberTool,
} from "./components/serialNumberTool";
import { generatePickerRenders, layoutRenders } from "./excalidrawRenders";
import {
	FONT_SIZE_MAX_VALUE,
	STROKE_WIDTH_MAX_VALUE,
} from "./excalidrawRenders/radioSlider";
import {
	convertLocalToLocalCode,
	type DrawCoreActionType,
	DrawStatePublisher,
	ExcalidrawEventCallbackPublisher,
	ExcalidrawEventCallbackType,
	ExcalidrawEventPublisher,
	ExcalidrawKeyEventPublisher,
	ExcalidrawOnHandleEraserPublisher,
} from "./extra";

const Excalidraw = lazy(() =>
	import("@mg-chao/excalidraw").then((module) => ({
		default: module.Excalidraw,
	})),
);

const strokeWidthList = [1, 2, 4];
const fontSizeList = [16, 20, 28, 36];

// 在 DrawCacheLayerCore 组件外部添加一个辅助函数
const getNextValueInList = <T,>(
	currentValue: T,
	valueList: T[],
	isIncrease: boolean,
): T => {
	const currentIndex = valueList.indexOf(currentValue);
	if (currentIndex !== -1) {
		if (isIncrease) {
			// 选择下一个值（不循环，达到最大值后保持不变）
			if (currentIndex < valueList.length - 1) {
				return valueList[currentIndex + 1];
			} else {
				return currentValue;
			}
		} else {
			// 选择上一个值（不循环，达到最小值后保持不变）
			if (currentIndex > 0) {
				return valueList[currentIndex - 1];
			} else {
				return currentValue;
			}
		}
	} else {
		// 如果当前值不在列表中
		return isIncrease ? valueList[0] : valueList[valueList.length - 1];
	}
};

export const convertToolTypeToDrawState = (
	toolType: ToolType,
): DrawState | undefined => {
	switch (toolType) {
		case "hand":
			return DrawState.Idle;
		case "selection":
			return DrawState.Select;
		case "rectangle":
			return DrawState.Rect;
		case "diamond":
			return DrawState.Diamond;
		case "ellipse":
			return DrawState.Ellipse;
		case "arrow":
			return DrawState.Arrow;
		case "line":
			return DrawState.Line;
		case "freedraw":
			return DrawState.Pen;
		case "text":
			return DrawState.Text;
		case "blur":
			return DrawState.Blur;
		case "blur_freedraw":
			return DrawState.BlurFreeDraw;
		case "watermark":
			return DrawState.Watermark;
		case "highlight":
			return DrawState.Highlight;
		case "eraser":
			return DrawState.Eraser;
	}

	return undefined;
};

const storageKey = "global";
const DrawCoreComponent: React.FC<{
	actionRef: React.RefObject<DrawCoreActionType | undefined>;
	zIndex: number;
	layoutMenuZIndex: number;
	excalidrawCustomOptions?: NonNullable<ExcalidrawPropsCustomOptions>;
	onLoad?: () => void;
	onAppStateStoreReady?: () => void;
	appStateStorageKey?: string;
}> = ({
	actionRef,
	zIndex,
	layoutMenuZIndex,
	excalidrawCustomOptions: excalidrawCustomOptionsProp,
	onLoad,
	onAppStateStoreReady,
	appStateStorageKey = storageKey,
}) => {
	const { token } = theme.useToken();
	const intl = useIntl();

	const { history } = useHistory();

	const initialData = useMemo<ExcalidrawInitialDataState>(() => {
		return {
			appState: { viewBackgroundColor: "#00000000" },
		};
	}, []);

	const [getDrawState] = useStateSubscriber(DrawStatePublisher, undefined);
	const [, setExcalidrawEvent] = useStateSubscriber(
		ExcalidrawEventPublisher,
		undefined,
	);
	const [, setExcalidrawOnHandleEraserEvent] = useStateSubscriber(
		ExcalidrawOnHandleEraserPublisher,
		undefined,
	);
	const [getExcalidrawKeyEvent] = useStateSubscriber(
		ExcalidrawKeyEventPublisher,
		undefined,
	);
	const [, setExcalidrawEventCallback] = useStateSubscriber(
		ExcalidrawEventCallbackPublisher,
		undefined,
	);
	const drawCacheLayerElementRef = useRef<HTMLDivElement>(null);
	const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI>(undefined);
	const excalidrawAPI = useCallback((api: ExcalidrawImperativeAPI) => {
		excalidrawAPIRef.current = api;
	}, []);
	const excalidrawActionRef = useRef<ExcalidrawActionType>(undefined);

	const updateScene = useCallback<DrawCoreActionType["updateScene"]>(
		(...args) => {
			excalidrawAPIRef.current?.updateScene(...args);
		},
		[],
	);

	const getCanvas = useCallback<DrawCoreActionType["getCanvas"]>(() => {
		const canvas = document.getElementById(
			"excalidraw__content-canvas",
		) as HTMLCanvasElement | null;
		return canvas;
	}, []);

	const getCanvasContext = useCallback<
		DrawCoreActionType["getCanvasContext"]
	>(() => {
		const canvas = getCanvas();
		if (!canvas) {
			return;
		}

		return canvas.getContext("2d");
	}, [getCanvas]);

	const getImageBitmap = useCallback<DrawCoreActionType["getImageBitmap"]>(
		async (selectRect: ElementRect) => {
			const canvas = getCanvas();
			if (!canvas) {
				return;
			}

			return window.createImageBitmap(
				canvas,
				selectRect.min_x,
				selectRect.min_y,
				selectRect.max_x - selectRect.min_x,
				selectRect.max_y - selectRect.min_y,
			);
		},
		[getCanvas],
	);

	const excalidrawAppStateStoreRef = useRef<ExcalidrawAppStateStore>(undefined);
	const excalidrawAppStateStoreValue = useRef<
		| {
				appState: Partial<AppState>;
		  }
		| undefined
	>(undefined);

	// [验证] macOS 文字拖动问题诊断：对比 document 层与 canvas 层能否收到 pointermove
	useEffect(() => {
		if (currentPlatformRef.current !== "macos") return;
		// 文档层
		let docCount = 0;
		const onDocMove = () => {
			docCount++;
			if (docCount % 30 === 1) {
				console.warn(
					`[DIAG] document pointermove 收到 ${docCount} 次`,
				);
			}
		};
		document.addEventListener("pointermove", onDocMove, true);

		// canvas 层：Excalidraw 的交互层
		let canvasCount = 0;
		const checkCanvas = () => {
			const canvas = getExcalidrawCanvas();
			if (!canvas) return;
			const onCanvasMove = () => {
				canvasCount++;
				if (canvasCount % 30 === 1) {
					console.warn(
						`[DIAG] canvas pointermove 收到 ${canvasCount} 次`,
					);
				}
			};
			canvas.addEventListener("pointermove", onCanvasMove, true);
			const onCanvasDown = () => {
				console.warn("[DIAG] canvas pointerdown 命中");
			};
			canvas.addEventListener("pointerdown", onCanvasDown, true);
		};
		const timer = setInterval(checkCanvas, 500);
		checkCanvas();

		return () => {
			document.removeEventListener("pointermove", onDocMove, true);
			clearInterval(timer);
		};
	}, [currentPlatformRef]);

	useEffect(() => {
		if (excalidrawAppStateStoreRef.current) {
			return;
		}

		excalidrawAppStateStoreRef.current = new ExcalidrawAppStateStore();
		excalidrawAppStateStoreRef.current.init().then(() => {
			if (!excalidrawAppStateStoreRef.current) {
				appWarn("[updateScene] excalidrawAppStateStoreRef.current is null");
				return;
			}

			excalidrawAppStateStoreRef.current
				.get(appStateStorageKey)
				.then((value) => {
					if (value) {
						if (excalidrawAPIRef.current) {
							// 未初始化 setstate 报错，未发现具体原因，延迟处理下
							setTimeout(() => {
								// biome-ignore lint/style/noNonNullAssertion: 已经确保 excalidrawAPIRef.current 不为空
								excalidrawAPIRef.current!.updateScene({
									appState: {
										...(value.appState as AppState),
										viewBackgroundColor: "#00000000",
									},
								});
							}, 0);
						} else {
							excalidrawAppStateStoreValue.current = {
								appState: {
									...(value.appState as AppState),
									viewBackgroundColor: "#00000000",
								},
							};
						}
					}

					setTimeout(() => {
						onAppStateStoreReady?.();
					}, 17);
				});
		});
	}, [appStateStorageKey, onAppStateStoreReady]);

	const [
		enableSliderChangeWidth,
		setEnableSliderChangeWidth,
		enableSliderChangeWidthRef,
	] = useStateRef(false);
	const toolIndependentStyleRef = useRef(false);
	const disableQuickSelectElementToolListRef = useRef<Set<DrawState>>(
		new Set(),
	);
	useAppSettingsLoad(
		useCallback(
			(appSettings) => {
				setEnableSliderChangeWidth(
					appSettings[AppSettingsGroup.FunctionDraw].enableSliderChangeWidth,
				);
				toolIndependentStyleRef.current =
					appSettings[AppSettingsGroup.FunctionDraw].toolIndependentStyle;
				disableQuickSelectElementToolListRef.current = new Set(
					appSettings[AppSettingsGroup.FunctionDraw]
						.disableQuickSelectElementToolList,
				);
			},
			[setEnableSliderChangeWidth],
		),
		true,
	);

	const handleWheel = useCallback(
		(
			event: WheelEvent | React.WheelEvent<HTMLDivElement | HTMLCanvasElement>,
			zoomAction?: () => void,
		) => {
			if ((event.metaKey || event.ctrlKey) && zoomAction) {
				zoomAction();
				return;
			}
		},
		[],
	);

	const handleContainerWheel = useCallback<
		NonNullable<ExcalidrawPropsCustomOptions["onContainerWheel"]>
	>(
		(event) => {
			if (!excalidrawAPIRef.current) {
				return;
			}

			if (event.metaKey || event.ctrlKey) {
				return;
			}

			const appState = excalidrawAPIRef.current.getAppState();
			if (!appState) {
				return;
			}

			const isIncrease = event.deltaY < 0;

			// 判断是否有选中单个元素
			// 只对单个元素的情况进行处理
			const sceneElements = excalidrawAPIRef.current?.getSceneElements() ?? [];
			let selectedElement: ExcalidrawElement | undefined;
			const selectedElementIds = appState.selectedElementIds;
			if (Object.keys(selectedElementIds).length === 1) {
				selectedElement = sceneElements.find(
					(item) => selectedElementIds[item.id],
				);
			}
			let editingTextElement: typeof appState.editingTextElement | undefined;
			if (appState.editingTextElement) {
				editingTextElement = appState.editingTextElement;
			}

			let changeTargetProp:
				| {
						blur: number;
				  }
				| {
						fontSize: number;
				  }
				| {
						strokeWidth: number;
				  };
			if (
				getDrawState() === DrawState.Blur ||
				selectedElement?.type === "blur"
			) {
				const currentBlur =
					selectedElement && "blur" in selectedElement
						? selectedElement.blur
						: appState.currentItemBlur;
				const targetBlur = Math.max(
					Math.min(currentBlur + (isIncrease ? 1 : -1) * 10, 100),
					0,
				);

				changeTargetProp = {
					blur: targetBlur,
				};
			} else if (
				getDrawState() === DrawState.Text ||
				getDrawState() === DrawState.SerialNumber ||
				getDrawState() === DrawState.Watermark ||
				editingTextElement?.type === "text" ||
				selectedElement?.type === "text"
			) {
				let currentFontSize: number;
				if (editingTextElement && "fontSize" in editingTextElement) {
					currentFontSize = editingTextElement.fontSize;
				} else if (selectedElement && "fontSize" in selectedElement) {
					currentFontSize = selectedElement.fontSize;
				} else {
					currentFontSize = appState.currentItemFontSize;
				}

				let targetFontSize: number;
				if (enableSliderChangeWidthRef.current) {
					targetFontSize = Math.min(
						Math.max(currentFontSize + (isIncrease ? 1 : -1) * 2, 1),
						FONT_SIZE_MAX_VALUE,
					);
				} else {
					targetFontSize = getNextValueInList(
						currentFontSize,
						fontSizeList,
						isIncrease,
					);
				}

				changeTargetProp = {
					fontSize: targetFontSize,
				};
			} else {
				const currentStrokeWidth =
					selectedElement && "strokeWidth" in selectedElement
						? selectedElement.strokeWidth
						: appState.currentItemStrokeWidth;
				let targetStrokeWidth: number;
				if (enableSliderChangeWidthRef.current) {
					targetStrokeWidth = Math.min(
						Math.max(currentStrokeWidth + (isIncrease ? 1 : -1) * 2, 1),
						STROKE_WIDTH_MAX_VALUE,
					);
				} else {
					targetStrokeWidth = getNextValueInList(
						currentStrokeWidth,
						strokeWidthList,
						isIncrease,
					);
				}

				changeTargetProp = {
					strokeWidth: targetStrokeWidth,
				};
			}

			if ("fontSize" in changeTargetProp) {
				setExcalidrawEventCallback({
					event: ExcalidrawEventCallbackType.ChangeFontSize,
					params: {
						fontSize: changeTargetProp.fontSize,
						drawState: getDrawState(),
					},
				});
				setExcalidrawEventCallback(undefined);
			} else if ("strokeWidth" in changeTargetProp) {
				if (selectedElement) {
					excalidrawAPIRef.current?.updateScene({
						elements: sceneElements.map((item): ExcalidrawElement => {
							if (item.id === selectedElement.id) {
								return {
									...item,
									strokeWidth: changeTargetProp.strokeWidth,
								};
							}

							return item;
						}),
						captureUpdate: "IMMEDIATELY",
					});
				} else {
					excalidrawAPIRef.current?.updateScene({
						appState: {
							...appState,
							currentItemStrokeWidth: changeTargetProp.strokeWidth,
						},
					});
				}
			} else if ("blur" in changeTargetProp) {
				if (selectedElement) {
					excalidrawAPIRef.current?.updateScene({
						elements: sceneElements.map((item) => {
							if (item.id === selectedElement.id) {
								return {
									...item,
									blur: changeTargetProp.blur,
								};
							}

							return item;
						}),
						captureUpdate: "IMMEDIATELY",
					});
				} else {
					excalidrawAPIRef.current?.updateScene({
						appState: {
							...appState,
							currentItemBlur: changeTargetProp.blur,
						},
					});
				}
			}
		},
		[enableSliderChangeWidthRef, getDrawState, setExcalidrawEventCallback],
	);

	const getAppStateStorageKey = useCallback(
		(drawState: DrawState) => {
			if (toolIndependentStyleRef.current) {
				return `${appStateStorageKey}:${drawState}`;
			}

			return appStateStorageKey;
		},
		[appStateStorageKey],
	);

	const needSaveAppState = useCallback((drawState: DrawState) => {
		switch (drawState) {
			case DrawState.Rect:
			case DrawState.Diamond:
			case DrawState.Ellipse:
			case DrawState.Arrow:
			case DrawState.Line:
			case DrawState.Pen:
			case DrawState.Text:
			case DrawState.SerialNumber:
			case DrawState.Blur:
			case DrawState.BlurFreeDraw:
			case DrawState.Watermark:
			case DrawState.Highlight:
				return true;
			default:
				return false;
		}
	}, []);

	useImperativeHandle(
		actionRef,
		() => ({
			setActiveTool: (tool, keepSelection, drawState) => {
				const appStateStore = excalidrawAppStateStoreRef.current;

				if (!appStateStore?.inited()) {
					return;
				}

				if (
					drawState &&
					needSaveAppState(drawState) &&
					toolIndependentStyleRef.current &&
					appStateStore
				) {
					// 读取 AppState
					appStateStore
						.get(getAppStateStorageKey(drawState))
						.then((value) => {
							if (!value) {
								return;
							}

							const appState = excalidrawAPIRef.current?.getAppState();
							if (!appState) {
								return;
							}

							excalidrawAPIRef.current?.updateScene({
								appState: {
									...appState,
									...(value.appState as AppState),
								},
								captureUpdate: "NEVER",
							});
						})
						.finally(() => {
							excalidrawAPIRef.current?.setActiveTool(tool, keepSelection);
						});
				} else {
					excalidrawAPIRef.current?.setActiveTool(tool, keepSelection);
				}
			},
			syncActionResult: (...args) => {
				excalidrawActionRef.current?.syncActionResult(...args);
			},
			updateScene,
			getAppState: () => {
				return excalidrawAPIRef.current?.getAppState();
			},
			getImageBitmap,
			getCanvasContext,
			getCanvas,
			getDrawCacheLayerElement: () => drawCacheLayerElementRef.current,
			getExcalidrawAPI: () => excalidrawAPIRef.current,
			finishDraw: () => {
				updateScene({
					appState: {
						// 清除在编辑中的元素
						newElement: null,
						editingTextElement: null,
						selectedLinearElement: null,
						selectionElement: null,
						selectedElementIds: {},
						selectedGroupIds: {},
						multiElement: null,
					},
					captureUpdate: "NEVER",
				});
			},
		}),
		[
			getAppStateStorageKey,
			getCanvas,
			getCanvasContext,
			getImageBitmap,
			needSaveAppState,
			updateScene,
		],
	);

	const [currentPlatform, currentPlatformRef] = usePlatform();

	// macOS 下 Ctrl、Shift、Command 等键浏览器不会响应，特殊处理下
	const shouldResizeFromCenter = useCallback<
		NonNullable<ExcalidrawPropsCustomOptions["shouldResizeFromCenter"]>
	>(
		(event) => {
			if (currentPlatformRef.current === "macos") {
				return event.altKey;
			}

			return getExcalidrawKeyEvent().resizeFromCenter;
		},
		[currentPlatformRef, getExcalidrawKeyEvent],
	);

	const shouldMaintainAspectRatio = useCallback<
		NonNullable<ExcalidrawPropsCustomOptions["shouldMaintainAspectRatio"]>
	>(
		(event) => {
			if (currentPlatformRef.current === "macos") {
				return event.shiftKey;
			}

			return getExcalidrawKeyEvent().maintainAspectRatio;
		},
		[currentPlatformRef, getExcalidrawKeyEvent],
	);

	const shouldRotateWithDiscreteAngle = useCallback<
		NonNullable<ExcalidrawPropsCustomOptions["shouldRotateWithDiscreteAngle"]>
	>(
		(event) => {
			if (currentPlatformRef.current === "macos") {
				return event.shiftKey;
			}

			return getExcalidrawKeyEvent().rotateWithDiscreteAngle;
		},
		[currentPlatformRef, getExcalidrawKeyEvent],
	);

	const shouldSnapping = useCallback<
		NonNullable<ExcalidrawPropsCustomOptions["shouldSnapping"]>
	>(
		(event) => {
			if (currentPlatformRef.current === "macos") {
				return event.metaKey;
			}

			return getExcalidrawKeyEvent().autoAlign;
		},
		[currentPlatformRef, getExcalidrawKeyEvent],
	);

	const onHistoryChange = useCallback<
		NonNullable<ExcalidrawPropsCustomOptions["onHistoryChange"]>
	>(
		(_, type) => {
			if (type === "record") {
				history.pushDrawCacheRecordAction(excalidrawActionRef);
			}
		},
		[history],
	);

	const saveAppState = useCallback(
		async (appState: Readonly<AppState> | undefined, drawState: DrawState) => {
			if (!appState) {
				return;
			}

			if (
				!needSaveAppState(drawState) ||
				!excalidrawAppStateStoreRef.current?.inited() ||
				Object.keys(appState.selectedElementIds).length > 0 // 选择状态不做更改
			) {
				return;
			}

			const storageAppState: Partial<AppState> = {};
			Object.keys(appState)
				.filter((item) => item.startsWith("currentItem"))
				.forEach((item) => {
					const value = appState[item as keyof AppState];
					if (value === undefined) {
						return;
					}

					storageAppState[item as keyof AppState] = value;
				});

			await excalidrawAppStateStoreRef.current.set(
				getAppStateStorageKey(drawState),
				{
					appState: storageAppState,
				},
			);
		},
		[getAppStateStorageKey, needSaveAppState],
	);
	const saveAppStateDebounce = useMemo(
		() => debounce(saveAppState, 256),
		[saveAppState],
	);

	const getExtraTools = useCallback<
		NonNullable<ExcalidrawPropsCustomOptions["getExtraTools"]>
	>(() => {
		if (getDrawState() === DrawState.SerialNumber) {
			return ["serialNumber"];
		}

		return [];
	}, [getDrawState]);

	const onPointerDown = useCallback<
		NonNullable<ExcalidrawProps["onPointerDown"]>
	>(
		(activeTool, pointerDownState) => {
			setExcalidrawEvent({
				event: "onPointerDown",
				params: {
					activeTool,
					pointerDownState,
				},
			});
			setExcalidrawEvent(undefined);
		},
		[setExcalidrawEvent],
	);
	const onPointerUp = useCallback<NonNullable<ExcalidrawProps["onPointerUp"]>>(
		(activeTool, pointerDownState) => {
			setExcalidrawEvent({
				event: "onPointerUp",
				params: {
					activeTool,
					pointerDownState,
				},
			});
			setExcalidrawEvent(undefined);
		},
		[setExcalidrawEvent],
	);

	const excalidrawAPICallback = useCallback<
		NonNullable<ExcalidrawProps["excalidrawAPI"]>
	>(
		(api) => {
			excalidrawAPI(api);

			if (excalidrawAppStateStoreValue.current) {
				// 未初始化 setstate 报错，未发现具体原因，延迟处理下
				setTimeout(() => {
					if (!excalidrawAppStateStoreValue.current) {
						return;
					}

					excalidrawAPIRef.current?.updateScene({
						appState: {
							...(excalidrawAppStateStoreValue.current.appState as AppState),
						},
					});
				}, 0);
			}

			setTimeout(() => {
				onLoad?.();
			}, 17);
		},
		[excalidrawAPI, onLoad],
	);

	const excalidrawOnChange = useCallback<
		NonNullable<ExcalidrawProps["onChange"]>
	>(
		(elements, appState, files) => {
			saveAppStateDebounce(appState, getDrawState());
			setExcalidrawEvent({
				event: "onChange",
				params: {
					elements,
					appState,
					files,
				},
			});
			setExcalidrawEvent(undefined);
		},
		[getDrawState, saveAppStateDebounce, setExcalidrawEvent],
	);

	const excalidrawCustomOptions = useMemo<
		NonNullable<ExcalidrawPropsCustomOptions>
	>(() => {
		return {
			disableKeyEvents: true,
			hideFooter: false,
			onWheel: handleWheel,
			onContainerWheel: handleContainerWheel,
			hideMainToolbar: true,
			hideContextMenu: true,
			shouldResizeFromCenter,
			shouldMaintainAspectRatio,
			shouldSnapping,
			getExtraTools,
			shouldRotateWithDiscreteAngle,
			pickerRenders: generatePickerRenders(enableSliderChangeWidth),
			layoutRenders: layoutRenders,
			onHistoryChange,
			onHandleEraser: (elements) => {
				setExcalidrawOnHandleEraserEvent({
					elements,
				});
			},
			canSelectType: () => {
				return !disableQuickSelectElementToolListRef.current.has(
					getDrawState(),
				);
			},
			...excalidrawCustomOptionsProp,
		};
	}, [
		handleWheel,
		handleContainerWheel,
		shouldResizeFromCenter,
		shouldMaintainAspectRatio,
		shouldSnapping,
		getExtraTools,
		shouldRotateWithDiscreteAngle,
		enableSliderChangeWidth,
		onHistoryChange,
		excalidrawCustomOptionsProp,
		setExcalidrawOnHandleEraserEvent,
		getDrawState,
	]);

	const excalidrawLangCode = useMemo(
		() => convertLocalToLocalCode(intl.locale),
		[intl.locale],
	);

	return (
		<SerialNumberContextProvider>
			<div ref={drawCacheLayerElementRef} className="draw-core-layer">
				<Excalidraw
					actionRef={excalidrawActionRef}
					initialData={initialData}
					handleKeyboardGlobally
					onPointerDown={onPointerDown}
					onPointerUp={onPointerUp}
					excalidrawAPI={excalidrawAPICallback}
					customOptions={excalidrawCustomOptions}
					onChange={excalidrawOnChange}
					langCode={excalidrawLangCode}
				/>
				{/* macOS 下 Ctrl、Shift、Command 等键浏览器不会响应，特殊处理下 */}
				{currentPlatform !== "macos" && <ExcalidrawKeyEventHandler />}

				<SerialNumberTool />

				<style jsx>{`
                        .draw-core-layer {
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                        }

                        .draw-core-layer :global(.excalidraw .layer-ui__wrapper) {
                            z-index: unset !important;
                        }

                        .draw-core-layer :global(.excalidraw .layout-menu-render) {
                            --popup-bg-color: ${token.colorBgContainer};
                            transform-origin: top left;
                        }

                        .draw-core-layer :global(.excalidraw .layout-menu-render .picker) {
                            box-shadow: 0 0 3px 0px ${token.colorInfoHover};
                        }

                        .draw-core-layer :global(.excalidraw .layout-menu-render) {
                            position: fixed;
                            z-index: ${layoutMenuZIndex};
                            left: 0;
                            top: 0;
                            box-sizing: border-box;
                            background-color: ${token.colorBgContainer};
                            transition: opacity ${token.motionDurationFast} ${token.motionEaseInOut};
                            box-shadow: 0 0 3px 0px ${token.colorPrimaryHover};
                            color: ${token.colorText};
                            border-radius: ${token.borderRadiusLG}px;
                            animation: slideIn ${token.motionDurationFast} ${token.motionEaseInOut};
                        }

                        @keyframes slideIn {
                            from {
                                opacity: 0;
                            }
                            to {
                                opacity: 1;
                            }
                        }

                        .draw-core-layer :global(.layout-menu-render-drag-button) {
                            text-align: center;
                            margin-top: ${token.marginXS}px;
                            margin-bottom: -${token.marginXS}px;
                        }

                        .draw-core-layer :global(.layout-menu-render-drag-button > span) {
                            transform: rotate(90deg);
                        }

                        .draw-core-layer :global(.Island.App-menu__left) {
                            --text-primary-color: ${token.colorText};

                            background-color: unset !important;
                            box-shadow: unset !important;
                            position: relative !important;
                            padding: ${token.paddingSM}px ${token.paddingSM}px !important;
                        }

                        .draw-core-layer :global(.excalidraw-container-inner) {
                            z-index: ${zIndex};
                            position: fixed;
                        }

                        .draw-core-layer :global(.excalidraw .radio-button-icon) {
                            width: var(--default-icon-size);
                            height: 100%;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: var(--default-icon-size);
                        }

                        .draw-core-layer :global(.excalidraw .subtool-radio-button-icon) {
                            height: 100%;
                            display: flex;
                            align-items: center;
                            padding-inline: ${token.paddingXS}px;
                            width: var(--default-icon-size);
                            font-size: var(--default-icon-size);
                        }

                        .draw-core-layer :global(.excalidraw .ant-radio-button-wrapper) {
                            padding-inline: ${0}px;
                        }

                        .draw-core-layer
                            :global(.excalidraw .ant-radio-button-wrapper .radio-button-icon) {
                            padding-inline: ${token.paddingXS}px;
                        }

                        .draw-core-layer :global(.drag-button) {
                            color: ${token.colorTextQuaternary};
                            cursor: move;
                        }

                        .draw-core-layer :global(.draw-toolbar-drag) {
                            font-size: 18px;
                            margin-right: -3px;
                            margin-left: -3px;
                        }

                        .draw-core-layer :global(.excalidraw .scroll-back-to-content) {
                            display: none;
                        }
                    `}</style>
			</div>
		</SerialNumberContextProvider>
	);
};

export const DrawCore = React.memo(
	withStatePublisher(
		DrawCoreComponent,
		ExcalidrawKeyEventPublisher,
		ExcalidrawEventCallbackPublisher,
	),
);
