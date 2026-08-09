"use client";

import { convertFileSrc } from "@tauri-apps/api/core";
import {
	type Window as AppWindow,
	getCurrentWindow,
	PhysicalPosition,
} from "@tauri-apps/api/window";
import { theme } from "antd";
import Color, { type ColorInstance } from "color";
import { debounce } from "es-toolkit";
import React, {
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { DrawStatePublisher } from "@/components/drawCore/extra";
import {
	AppSettingsActionContext,
	AppSettingsPublisher,
} from "@/contexts/appSettingsActionContext";
import {
	useCallbackRender,
	useCallbackRenderSlow,
} from "@/hooks/useCallbackRender";
import { withStatePublisher } from "@/hooks/useStatePublisher";
import { useStateRef } from "@/hooks/useStateRef";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { DrawToolbarStatePublisher } from "@/pages/draw/components/drawToolbar";
import { KeyEventWrap } from "@/pages/draw/components/drawToolbar/components/keyEventWrap";
import { EnableKeyEventPublisher } from "@/pages/draw/components/drawToolbar/components/keyEventWrap/extra";
import {
	DragMode,
	SelectState,
} from "@/pages/draw/components/selectLayer/extra";
import { useMonitorRect } from "@/pages/draw/components/statusBar";
import {
	CaptureEvent,
	type CaptureEventParams,
	CaptureEventPublisher,
	CaptureLoadingPublisher,
	CaptureStepPublisher,
	DrawEvent,
	DrawEventPublisher,
	ScreenshotTypePublisher,
} from "@/pages/draw/extra";
import type { ImageSharedBufferData } from "@/pages/draw/tools";
import { CaptureStep, DrawContext } from "@/pages/draw/types";
import { AppSettingsGroup, ColorPickerShowMode } from "@/types/appSettings";
import type { ImageBuffer } from "@/types/commands/screenshot";
import { DrawToolbarKeyEventKey } from "@/types/components/drawToolbar";
import { DrawState } from "@/types/draw";
import type { CaptureHistoryItem } from "@/utils/appStore";
import { getCaptureHistoryImageAbsPath } from "@/utils/captureHistory";
import { writeTextToClipboard } from "@/utils/clipboard";
import { supportOffscreenCanvas } from "@/utils/environment";
import { getExcalidrawCanvas } from "@/utils/excalidraw";
import { MousePosition } from "@/utils/mousePosition";
import { getPlatform } from "@/utils/platform";
import { ScreenshotType } from "@/utils/types";
import { zIndexs } from "@/utils/zIndex";
import {
	getPreviewImageDataAction,
	initImageDataAction,
	initPreviewCanvasAction,
	pickColorAction,
	putImageDataAction,
	switchCaptureHistoryAction,
	terminateWorkerAction,
} from "./actions";
import { useMoveCursor } from "./extra";
import {
	COLOR_PICKER_PREVIEW_CANVAS_SIZE,
	COLOR_PICKER_PREVIEW_PICKER_SIZE,
	COLOR_PICKER_PREVIEW_SCALE,
} from "./renderActions";

export const isEnableColorPicker = (
	captureStep: CaptureStep,
	drawState: DrawState,
	captureEvent: CaptureEventParams | undefined,
	toolbarMouseHover: boolean,
) => {
	if (captureEvent?.event !== CaptureEvent.onCaptureLoad) {
		return false;
	}

	if (toolbarMouseHover) {
		return false;
	}

	return (
		captureStep === CaptureStep.Select ||
		(captureStep === CaptureStep.Draw && drawState === DrawState.Idle)
	);
};

export type ColorPickerActionType = {
	getPreviewImageData: () => Promise<ImageData | null>;
	switchCaptureHistory: (item: CaptureHistoryItem | undefined) => Promise<void>;
	pickColor: (mousePosition: MousePosition) => Promise<string>;
	/** 强制启用取色器 */
	setForceEnable: (forceEnable: boolean) => void;
	/** 获取当前颜色 */
	getCurrentColor: () => ColorInstance | undefined;
};

export enum ColorPickerColorFormat {
	RGB = "rgb",
	HEX = "hex",
	HSL = "hsl",
}

const colorPickerColorFormatList = [
	ColorPickerColorFormat.HEX,
	ColorPickerColorFormat.RGB,
	ColorPickerColorFormat.HSL,
];

// 切换历史截图解码期间的锁，避免旧 ref 被取色/预览绘制读到
var isSwitchingHistory = false;

const ColorPickerCore: React.FC<{
	onCopyColor?: () => void;
	actionRef: React.Ref<ColorPickerActionType | undefined>;
}> = ({ onCopyColor, actionRef }) => {
	const [getCaptureStep] = useStateSubscriber(CaptureStepPublisher, undefined);
	const [getDrawState] = useStateSubscriber(DrawStatePublisher, undefined);
	const [getDrawToolbarState] = useStateSubscriber(
		DrawToolbarStatePublisher,
		undefined,
	);
	const [, setEnableKeyEvent] = useStateSubscriber(
		EnableKeyEventPublisher,
		undefined,
	);
	const [getCaptureEvent] = useStateSubscriber(
		CaptureEventPublisher,
		undefined,
	);
	const [getScreenshotType] = useStateSubscriber(
		ScreenshotTypePublisher,
		undefined,
	);
	const [getAppSettings] = useStateSubscriber(AppSettingsPublisher, undefined);
	const imageDataReadyRef = useRef(false);

	/** 强制启用取色器 */
	const [, setForceEnable, forceEnableRef] = useStateRef(false);

	const { updateAppSettings } = useContext(AppSettingsActionContext);

	const { token } = theme.useToken();

	const { captureBoundingBoxInfoRef, selectLayerActionRef } =
		useContext(DrawContext);

	const {
		contentScale: [, , contentScaleRef],
	} = useMonitorRect();
	const updateOpacity = useCallback(
		(hasDrag: boolean) => {
			if (!colorPickerRef.current) {
				return;
			}

			const captureBoundingBoxInfo = captureBoundingBoxInfoRef.current;
			if (!captureBoundingBoxInfo) {
				return;
			}

			if (!imageDataReadyRef.current) {
				return;
			}

			let opacity = "1";

			// 当拖动选区四个角落时，取色器保持显示，并且定位到四个角
			if (hasDrag) {
				opacity = "0.83";
			} else if (enableRef.current || forceEnableRef.current) {
				const mouseX = pickerPositionRef.current.mouseX;
				const mouseY = pickerPositionRef.current.mouseY;
				if (
					getAppSettings()[AppSettingsGroup.Screenshot].colorPickerShowMode ===
					ColorPickerShowMode.BeyondSelectRect
				) {
					const selectRect = selectLayerActionRef.current?.getSelectRect();
					if (selectRect) {
						const tolerance = token.marginXXS;

						if (
							mouseX > selectRect.min_x - tolerance &&
							mouseX < selectRect.max_x + tolerance &&
							mouseY > selectRect.min_y - tolerance &&
							mouseY < selectRect.max_y + tolerance
						) {
							opacity = "1";
						} else {
							opacity = "0";
						}
					} else {
						opacity = "0";
					}
				} else if (
					getAppSettings()[AppSettingsGroup.Screenshot].colorPickerShowMode ===
					ColorPickerShowMode.Never
				) {
					opacity = "0";
				} else {
					opacity = "1";
				}

				if (opacity === "1") {
					// 获取选区的状态，如果是未选定的状态，加个透明度
					const selectState = selectLayerActionRef.current?.getSelectState();
					if (
						selectState === SelectState.Manual ||
						selectState === SelectState.Drag
					) {
						opacity = "0.5";
					} else if (
						selectState === SelectState.Auto &&
						colorPickerRef.current
					) {
						// 这时是自动选区，那就根据是否在边缘判断
						// 一般都是从左上到右下，所以只判断右下边缘即可
						const maxX =
							captureBoundingBoxInfo.width -
							colorPickerRef.current.clientWidth *
								window.devicePixelRatio *
								contentScaleRef.current;
						const maxY =
							captureBoundingBoxInfo.height -
							colorPickerRef.current.clientHeight *
								window.devicePixelRatio *
								contentScaleRef.current;
						if (mouseX > maxX || mouseY > maxY) {
							opacity = "0.5";
						}
					}
				}
			} else {
				opacity = "0";
			}

			colorPickerRef.current.style.opacity = opacity;
		},
		[
			captureBoundingBoxInfoRef,
			forceEnableRef,
			getAppSettings,
			selectLayerActionRef,
			token.marginXXS,
			contentScaleRef,
		],
	);

	const appWindowRef = useRef<AppWindow | undefined>(undefined);
	useEffect(() => {
		appWindowRef.current = getCurrentWindow();
	}, []);

	const colorPickerRef = useRef<HTMLDivElement>(null);
	const previewCanvasRef = useRef<HTMLCanvasElement>(null);
	const previewOffscreenCanvasRef = useRef<OffscreenCanvas>(null);
	const previewCanvasCtxRef = useRef<CanvasRenderingContext2D | null>(null);
	const pickerPositionRef = useRef<MousePosition>(new MousePosition(0, 0));
	const updatePickerPosition = useCallback(
		(
			x: number,
			y: number,
			dragPosition: { x: number; y: number } | undefined,
		) => {
			pickerPositionRef.current.mouseX = x;
			pickerPositionRef.current.mouseY = y;

			if (!pickerPositionElementRef.current) {
				return;
			}

			if (dragPosition) {
				pickerPositionElementRef.current.textContent = `X: ${dragPosition.x} Y: ${dragPosition.y}`;
			} else {
				pickerPositionElementRef.current.textContent = `X: ${x} Y: ${y}`;
			}
		},
		[],
	);

	const [renderWorker, setRenderWorker] = useState<Worker | undefined>(
		undefined,
	);
	useEffect(() => {
		let worker: Worker | undefined;
		if (supportOffscreenCanvas()) {
			worker = new Worker(
				new URL("./workers/renderWorker.ts", import.meta.url),
			);
			setRenderWorker(worker);
		}

		return () => {
			terminateWorkerAction();
			worker?.terminate();
		};
	}, []);

	const enableRef = useRef(false);
	const onEnableChange = useCallback(
		(enable: boolean) => {
			enableRef.current = enable;

			updateOpacity(false);
		},
		[updateOpacity],
	);

	const updateEnable = useCallback(() => {
		const enable =
			getScreenshotType()?.type !== ScreenshotType.TopWindow &&
			isEnableColorPicker(
				getCaptureStep(),
				getDrawState(),
				getCaptureEvent(),
				getDrawToolbarState().mouseHover,
			);
		if (enableRef.current === enable) {
			return;
		}

		onEnableChange(enable);
	}, [
		getCaptureEvent,
		getCaptureStep,
		getDrawState,
		getScreenshotType,
		getDrawToolbarState,
		onEnableChange,
	]);
	const updateEnableDebounce = useMemo(
		() => debounce(updateEnable, 17),
		[updateEnable],
	);
	useStateSubscriber(CaptureStepPublisher, updateEnableDebounce);
	useStateSubscriber(
		DrawStatePublisher,
		useCallback(
			(drawState: DrawState) => {
				if (colorPickerRef.current) {
					// 直接隐藏取色器，防止滚动截图干扰
					if (drawState === DrawState.ScrollScreenshot) {
						colorPickerRef.current.style.scale = "0";
					} else {
						colorPickerRef.current.style.scale = "1";
					}
				}

				updateEnableDebounce();
			},
			[updateEnableDebounce],
		),
	);
	useStateSubscriber(CaptureEventPublisher, updateEnableDebounce);
	useStateSubscriber(ScreenshotTypePublisher, updateEnableDebounce);
	useStateSubscriber(DrawToolbarStatePublisher, updateEnableDebounce);
	const [, setDrawEvent] = useStateSubscriber(DrawEventPublisher, undefined);

	const previewImageDataRef = useRef<ImageData | null>(null);
	const captureHistoryImageDataRef = useRef<ImageData | undefined>(undefined);
	const getPreviewImageData = useCallback(async () => {
		return await getPreviewImageDataAction(
			renderWorker,
			previewImageDataRef,
			captureHistoryImageDataRef,
		);
	}, [renderWorker]);

	const colorRef = useRef({
		red: 0,
		green: 0,
		blue: 0,
	});
	// usestate 的性能太低了，直接用 ref 更新
	const colorElementRef = useRef<HTMLDivElement>(null);
	const previewColorElementRef = useRef<HTMLDivElement>(null);
	const previewCanvasContainerRef = useRef<HTMLDivElement>(null);

	const currentColorRef = useRef<ColorInstance | undefined>(undefined);

	const getFormatColor = useCallback(
		(red: number, green: number, blue: number) => {
			const currentColor = new Color({
				r: red,
				g: green,
				b: blue,
			});
			currentColorRef.current = currentColor;
			setDrawEvent({
				event: DrawEvent.ColorPickerColorChange,
				params: {
					color: currentColor,
				},
			});
			setDrawEvent(undefined);

			const colorFormatIndex =
				colorPickerColorFormatList[
					getAppSettings()[AppSettingsGroup.Cache].colorPickerColorFormatIndex
				] ?? ColorPickerColorFormat.HEX;

			switch (colorFormatIndex) {
				case ColorPickerColorFormat.HEX:
					return currentColor.hex().toString();
				case ColorPickerColorFormat.HSL: {
					const hsl = currentColor.hsl();
					return `hsl(${hsl.hue().toFixed(1)}, ${hsl.saturationl().toFixed(1)}%, ${hsl.lightness().toFixed(1)}%)`;
				}
				case ColorPickerColorFormat.RGB:
					return currentColor.rgb().string();
			}
		},
		[getAppSettings, setDrawEvent],
	);
	const updateColor = useCallback(
		(red: number, green: number, blue: number) => {
			colorRef.current.red = red;
			colorRef.current.green = green;
			colorRef.current.blue = blue;
			if (!colorElementRef.current || !previewColorElementRef.current) {
				return;
			}

			colorElementRef.current.style.backgroundColor = `rgb(${red}, ${green}, ${blue})`;
			colorElementRef.current.style.color =
				red > 128 || green > 128 || blue > 128
					? "rgba(0,0,0,0.88)"
					: "rgba(255,255,255,0.85)";
			colorElementRef.current.textContent = getFormatColor(red, green, blue);
			previewColorElementRef.current.style.boxShadow = `0 0 0 1px ${colorElementRef.current.style.color}`;
		},
		[getFormatColor],
	);

	const pickerPositionElementRef = useRef<HTMLDivElement>(null);

	const { isDisableMouseMove, enableMouseMove, disableMouseMove } =
		useMoveCursor();
	const updateImageDataPutImage = useCallback(
		async (x: number, y: number, colorX: number, colorY: number) => {
			const color = await putImageDataAction(
				renderWorker,
				previewCanvasCtxRef,
				previewImageDataRef,
				captureHistoryImageDataRef,
				x,
				y,
				colorX,
				colorY,
				getAppSettings()[AppSettingsGroup.Screenshot]
					.colorPickerCenterAuxiliaryLineColor,
			);

			// 更新颜色
			updateColor(color.color[0], color.color[1], color.color[2]);
		},
		[getAppSettings, renderWorker, updateColor],
	);

	const updateImageDataPutImageRender = useCallbackRender(
		updateImageDataPutImage,
	);
	const updateImageData = useCallback(
		async (
			mouseX: number,
			mouseY: number,
			physicalX?: number,
			physicalY?: number,
			dragPosition?: { x: number; y: number },
		) => {
			const captureBoundingBoxInfo = captureBoundingBoxInfoRef.current;
			if (!captureBoundingBoxInfo) {
				return;
			}

			// 恢复鼠标事件触发
			enableMouseMove();

			mouseX = Math.min(
				Math.max(0, physicalX ?? Math.floor(mouseX * window.devicePixelRatio)),
				captureBoundingBoxInfo.width - 1,
			);
			mouseY = Math.min(
				Math.max(0, physicalY ?? Math.floor(mouseY * window.devicePixelRatio)),
				captureBoundingBoxInfo.height - 1,
			);

			const halfPickerSize = Math.floor(COLOR_PICKER_PREVIEW_PICKER_SIZE / 2);

			// 计算和绘制错开 1 帧率
			if (dragPosition) {
				// 将数据绘制到预览画布
				updatePickerPosition(mouseX, mouseY, dragPosition);
				updateImageDataPutImageRender(
					dragPosition.x - halfPickerSize,
					dragPosition.y - halfPickerSize,
					dragPosition.x,
					dragPosition.y,
				);
			} else {
				updatePickerPosition(mouseX, mouseY, undefined);
				updateImageDataPutImageRender(
					mouseX - halfPickerSize,
					mouseY - halfPickerSize,
					mouseX,
					mouseY,
				);
			}
		},
		[
			captureBoundingBoxInfoRef,
			enableMouseMove,
			updateImageDataPutImageRender,
			updatePickerPosition,
		],
	);
	const updateImageRender = useCallbackRenderSlow(updateImageData);

	const updateTransform = useCallback(
		(
			mouseX: number,
			mouseY: number,
			dragPosition: { x: number; y: number } | undefined,
		) => {
			const colorPickerElement = colorPickerRef.current;
			if (!colorPickerElement) {
				return;
			}

			const colorPickerWidth =
				colorPickerElement.clientWidth * contentScaleRef.current;
			const colorPickerHeight =
				colorPickerElement.clientHeight * contentScaleRef.current;

			const canvasWidth = document.body.clientWidth;
			const canvasHeight = document.body.clientHeight;

			const maxTop = canvasHeight - colorPickerHeight;
			const maxLeft = canvasWidth - colorPickerWidth;

			let colorPickerLeft: number;
			let colorPickerTop: number;
			if (dragPosition) {
				colorPickerLeft = dragPosition.x / window.devicePixelRatio;
				colorPickerTop = dragPosition.y / window.devicePixelRatio;
			} else {
				colorPickerLeft = Math.min(Math.max(mouseX, 0), maxLeft);
				colorPickerTop = Math.min(Math.max(mouseY, 0), maxTop);
			}

			colorPickerElement.style.transform = `translate(${colorPickerLeft}px, ${colorPickerTop}px) scale(${contentScaleRef.current})`;

			updateOpacity(dragPosition !== undefined);
		},
		[contentScaleRef, updateOpacity],
	);
	const updateTransformRender = useCallbackRender(updateTransform);

	const getDragPosition = useCallback(() => {
		let dragPosition: { x: number; y: number } | undefined;
		if (
			selectLayerActionRef.current &&
			selectLayerActionRef.current.getSelectState() === SelectState.Drag &&
			(selectLayerActionRef.current.getDragMode() === DragMode.TopLeft ||
				selectLayerActionRef.current?.getDragMode() === DragMode.TopRight ||
				selectLayerActionRef.current.getDragMode() === DragMode.BottomLeft ||
				selectLayerActionRef.current.getDragMode() === DragMode.BottomRight)
		) {
			const selectRect = selectLayerActionRef.current.getSelectRect();
			if (!selectRect) {
				return undefined;
			}
			dragPosition = {
				x: 0,
				y: 0,
			};
			if (selectLayerActionRef.current.getDragMode() === DragMode.TopLeft) {
				dragPosition.x = selectRect.min_x;
				dragPosition.y = selectRect.min_y;
			} else if (
				selectLayerActionRef.current.getDragMode() === DragMode.TopRight
			) {
				dragPosition.x = selectRect.max_x;
				dragPosition.y = selectRect.min_y;
			} else if (
				selectLayerActionRef.current.getDragMode() === DragMode.BottomLeft
			) {
				dragPosition.x = selectRect.min_x;
				dragPosition.y = selectRect.max_y;
			} else if (
				selectLayerActionRef.current.getDragMode() === DragMode.BottomRight
			) {
				dragPosition.x = selectRect.max_x;
				dragPosition.y = selectRect.max_y;
			}
		}
		return dragPosition;
	}, [selectLayerActionRef]);

	const update = useCallback(
		(
			mouseX: number,
			mouseY: number,
			physicalX?: number,
			physicalY?: number,
		) => {
			if (isSwitchingHistory) return;

			const dragPosition = getDragPosition();

			updateTransformRender(mouseX, mouseY, dragPosition);
			updateImageRender(mouseX, mouseY, physicalX, physicalY, dragPosition);
		},
		[getDragPosition, updateImageRender, updateTransformRender],
	);

	const initPreviewCanvas = useCallback(async () => {
		const previewCanvasElement = document.createElement("canvas");
		previewCanvasElement.className = "preview-canvas";
		if (previewCanvasContainerRef.current) {
			if (previewCanvasContainerRef.current.firstChild) {
				previewCanvasContainerRef.current.removeChild(
					previewCanvasContainerRef.current.firstChild,
				);
			}
			previewCanvasContainerRef.current.appendChild(previewCanvasElement);
		}

		previewOffscreenCanvasRef.current =
			supportOffscreenCanvas() && renderWorker
				? previewCanvasElement.transferControlToOffscreen()
				: null;

		await initPreviewCanvasAction(
			renderWorker,
			previewCanvasRef,
			previewCanvasElement,
			previewOffscreenCanvasRef,
			previewCanvasCtxRef,
			previewOffscreenCanvasRef.current
				? [previewOffscreenCanvasRef.current]
				: undefined,
		);
	}, [renderWorker]);

	const refreshMouseMove = useCallback(() => {
		update(
			Math.floor(pickerPositionRef.current.mouseX / window.devicePixelRatio),
			Math.floor(pickerPositionRef.current.mouseY / window.devicePixelRatio),
			pickerPositionRef.current.mouseX,
			pickerPositionRef.current.mouseY,
		);
	}, [update]);

	const initImageData = useCallback(
		async (imageBuffer: ImageBuffer | ImageSharedBufferData) => {
			await initImageDataAction(
				renderWorker,
				previewCanvasRef,
				previewImageDataRef,
				imageBuffer,
			);
			imageDataReadyRef.current = true;
			refreshMouseMove();
		},
		[renderWorker, refreshMouseMove],
	);

	const onCaptureImageBufferReady = useCallback(
		async (imageBuffer: ImageBuffer | ImageSharedBufferData) => {
			let buffer = imageBuffer;
			// 克隆给 worker 使用
			if ("sharedBuffer" in imageBuffer) {
				buffer = {
					...imageBuffer,
					sharedBuffer: new Uint8ClampedArray(
						imageBuffer.sharedBuffer.buffer.slice(
							0,
							imageBuffer.sharedBuffer.byteLength,
						),
					),
				};
			}

			await initImageData(buffer);
		},
		[initImageData],
	);
	const onCaptureLoad = useCallback(
		(captureLoading: boolean) => {
			setEnableKeyEvent(!captureLoading);
		},
		[setEnableKeyEvent],
	);
	useStateSubscriber(CaptureLoadingPublisher, onCaptureLoad);

	useStateSubscriber(
		CaptureEventPublisher,
		useCallback(
			(captureEvent: CaptureEventParams | undefined) => {
				if (captureEvent?.event === CaptureEvent.onCaptureFinish) {
					imageDataReadyRef.current = false;
					// 截图结束时立即隐藏取色器，防止在上次位置闪烁
					if (colorPickerRef.current) {
						colorPickerRef.current.style.opacity = "0";
					}
				} else if (
					captureEvent?.event === CaptureEvent.onCaptureImageBufferReady
				) {
					// 可能是切换截图历史，这种情况下不存在截图数据
					if (captureEvent.params.imageBuffer) {
						onCaptureImageBufferReady(captureEvent.params.imageBuffer);
					}
				}
			},
			[onCaptureImageBufferReady],
		),
	);

	useEffect(() => {
		const handlePointerMove = (e: PointerEvent) => {
			if (isDisableMouseMove()) {
				return;
			}

			update(e.clientX, e.clientY);
		};

		document.addEventListener("pointermove", handlePointerMove);

		return () => {
			document.removeEventListener("pointermove", handlePointerMove);
		};
	}, [isDisableMouseMove, update]);

	const moveCursor = useCallback(
		(offsetX: number, offsetY: number) => {
			const appWindow = appWindowRef.current;
			if (!appWindow) {
				return;
			}

			let mouseX = 0;
			let mouseY = 0;
			mouseX = pickerPositionRef.current.mouseX + offsetX;
			mouseY = pickerPositionRef.current.mouseY + offsetY;

			if (mouseX < 0) {
				mouseX = 0;
			} else if (mouseX > (captureBoundingBoxInfoRef.current?.width ?? 0)) {
				mouseX = captureBoundingBoxInfoRef.current?.width ?? 0;
			}

			if (mouseY < 0) {
				mouseY = 0;
			} else if (
				captureBoundingBoxInfoRef.current &&
				mouseY > captureBoundingBoxInfoRef.current.height
			) {
				mouseY = captureBoundingBoxInfoRef.current.height;
			}

			disableMouseMove();
			appWindow.setCursorPosition(new PhysicalPosition(mouseX, mouseY));
			setDrawEvent({
				event: DrawEvent.MoveCursor,
				params: {
					x: mouseX,
					y: mouseY,
				},
			});
			setDrawEvent(undefined);

			// 在 macOS 下，鼠标移动不会触发 mousemove 事件，给 excalidraw 发送一个 mousemove 事件
			if (getPlatform() === "macos") {
				const canvas = getExcalidrawCanvas();
				canvas?.dispatchEvent(
					new PointerEvent("pointermove", {
						clientX: Math.round(mouseX / window.devicePixelRatio),
						clientY: Math.round(mouseY / window.devicePixelRatio),
						bubbles: true,
						cancelable: true,
					}),
				);
			}

			update(
				Math.round(mouseX / window.devicePixelRatio),
				Math.round(mouseY / window.devicePixelRatio),
				mouseX,
				mouseY,
			);
		},
		[captureBoundingBoxInfoRef, disableMouseMove, setDrawEvent, update],
	);

	const switchCaptureHistory = useCallback(
		async (item: CaptureHistoryItem | undefined) => {
			isSwitchingHistory = true;
			try {
				const fileUri = item
					? convertFileSrc(await getCaptureHistoryImageAbsPath(item.file_name))
					: undefined;
			await switchCaptureHistoryAction(
				renderWorker,
				captureHistoryImageDataRef,
				fileUri,
			);
			} finally {
				isSwitchingHistory = false;
				imageDataReadyRef.current = true;
				refreshMouseMove();
			}
		},
		[renderWorker, refreshMouseMove],
	);

	const pickColor = useCallback(
		async (mousePosition: MousePosition): Promise<string> => {
			const color = await pickColorAction(
				renderWorker,
				captureHistoryImageDataRef,
				previewImageDataRef,
				Math.round(mousePosition.mouseX * window.devicePixelRatio),
				Math.round(mousePosition.mouseY * window.devicePixelRatio),
			);

			return Color({
				r: color.color[0],
				g: color.color[1],
				b: color.color[2],
			})
				.hex()
				.toString();
		},
		[renderWorker],
	);

	useImperativeHandle(
		actionRef,
		() => ({
			getPreviewImageData,
			switchCaptureHistory,
			pickColor,
			setForceEnable,
			getCurrentColor: () => currentColorRef.current,
		}),
		[getPreviewImageData, switchCaptureHistory, pickColor, setForceEnable],
	);

	useEffect(() => {
		initPreviewCanvas();
	}, [initPreviewCanvas]);

	return (
		<div className="color-picker" ref={colorPickerRef}>
			<KeyEventWrap
				componentKey={DrawToolbarKeyEventKey.ColorPickerCopy}
				onKeyDown={() => {
					if (!enableRef.current) {
						return;
					}

					writeTextToClipboard(
						getFormatColor(
							colorRef.current.red,
							colorRef.current.green,
							colorRef.current.blue,
						),
					);
					onCopyColor?.();
				}}
			>
				<div />
			</KeyEventWrap>
			<KeyEventWrap
				componentKey={DrawToolbarKeyEventKey.ColorPickerMoveUp}
				onKeyDown={() => {
					moveCursor(0, -1);
				}}
			>
				<div />
			</KeyEventWrap>
			<KeyEventWrap
				componentKey={DrawToolbarKeyEventKey.ColorPickerMoveDown}
				onKeyDown={() => {
					moveCursor(0, 1);
				}}
			>
				<div />
			</KeyEventWrap>
			<KeyEventWrap
				componentKey={DrawToolbarKeyEventKey.ColorPickerMoveLeft}
				onKeyDown={() => {
					moveCursor(-1, 0);
				}}
			>
				<div />
			</KeyEventWrap>
			<KeyEventWrap
				componentKey={DrawToolbarKeyEventKey.ColorPickerMoveRight}
				onKeyDown={() => {
					moveCursor(1, 0);
				}}
			>
				<div />
			</KeyEventWrap>
			<KeyEventWrap
				componentKey={DrawToolbarKeyEventKey.SwitchColorFormat}
				onKeyUp={() => {
					if (!enableRef.current) {
						return;
					}

					// 手动框选时，会触发固定宽高，忽略切换颜色格式
					if (
						selectLayerActionRef.current?.getSelectState() ===
							SelectState.Manual ||
						selectLayerActionRef.current?.getSelectState() === SelectState.Drag
					) {
						return;
					}

					updateAppSettings(
						AppSettingsGroup.Cache,
						{
							colorPickerColorFormatIndex:
								(getAppSettings()[AppSettingsGroup.Cache]
									.colorPickerColorFormatIndex +
									1) %
								colorPickerColorFormatList.length,
						},
						false,
						true,
						false,
						true,
						false,
					);

					updateColor(
						colorRef.current.red,
						colorRef.current.green,
						colorRef.current.blue,
					);
				}}
			>
				<div />
			</KeyEventWrap>

			<div className="color-picker-container">
				<div className="color-picker-preview">
					<div ref={previewCanvasContainerRef} />
					<div
						ref={previewColorElementRef}
						className="color-picker-preview-border"
					/>
				</div>
			</div>

			<div className="color-picker-content">
				<div
					className="color-picker-content-text"
					ref={pickerPositionElementRef}
				></div>
				<div className="color-picker-content-color" ref={colorElementRef}></div>
			</div>
			<style jsx>
				{`
                    .color-picker {
                        user-select: none;
                        position: fixed;
                        top: 0;
                        left: 0;
                        background-color: ${token.colorBgContainer};
                        border-radius: ${token.borderRadius}px;
                        box-shadow: ${token.boxShadowSecondary};
                        z-index: ${zIndexs.Draw_ColorPicker};
                        pointer-events: none;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        opacity: 0;
                        color: ${token.colorText};
                        display: flex;
                        flex-direction: column;
                        padding: ${token.paddingXXS}px;
                        transition: opacity ${token.motionDurationFast} ${token.motionEaseInOut};
                        transform-origin: top left;
                    }

                    .color-picker-container {
                        width: ${COLOR_PICKER_PREVIEW_CANVAS_SIZE}px;
                        height: ${COLOR_PICKER_PREVIEW_CANVAS_SIZE}px;
                        border-radius: ${token.borderRadius}px;
                        overflow: hidden;
                    }

                    .color-picker-preview {
                    }

                    .color-picker-preview-border {
                        position: absolute;
                        width: ${1 * COLOR_PICKER_PREVIEW_SCALE}px;
                        height: ${1 * COLOR_PICKER_PREVIEW_SCALE}px;
                        left: ${COLOR_PICKER_PREVIEW_CANVAS_SIZE / 2 - 2}px;
                        top: ${COLOR_PICKER_PREVIEW_CANVAS_SIZE / 2 - 2}px;
                        background-color: transparent;
                        border-radius: ${token.borderRadiusXS}px;
                    }

                    .color-picker :global(.preview-canvas) {
                        width: ${COLOR_PICKER_PREVIEW_CANVAS_SIZE}px;
                        height: ${COLOR_PICKER_PREVIEW_CANVAS_SIZE}px;
                        image-rendering: pixelated;
                    }

                    .color-picker-content {
                        display: flex;
                        flex-direction: column;
                        gap: ${token.marginXXS}px;
                        margin-top: ${token.marginXXS}px;
                        font-size: ${token.fontSizeSM}px;
                        width: ${COLOR_PICKER_PREVIEW_CANVAS_SIZE}px;
                        border-bottom-left-radius: ${token.borderRadius}px;
                        border-bottom-right-radius: ${token.borderRadius}px;
                        overflow: hidden;
                    }

                    .color-picker-content-color {
                        padding: ${token.paddingXXS}px;
                        text-align: center;
                    }

                    .color-picker-content-text {
                        text-align: center;
                    }

                    .color-picker-content-text,
                    .color-picker-content-color {
                        user-select: none;
                        pointer-events: none;
                    }
                `}
			</style>
		</div>
	);
};

export const ColorPicker = React.memo(
	withStatePublisher(ColorPickerCore, EnableKeyEventPublisher),
);
