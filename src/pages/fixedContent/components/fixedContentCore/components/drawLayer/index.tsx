import type { ExcalidrawElement } from "@mg-chao/excalidraw/element/types";
import type { NormalizedZoomValue } from "@mg-chao/excalidraw/types";
import {
	getCurrentWindow,
	type PhysicalPosition,
	type PhysicalSize,
} from "@tauri-apps/api/window";
import { theme } from "antd";
import type React from "react";
import {
	Suspense,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	getMonitorsBoundingBox,
	type MonitorBoundingBox,
} from "@/commands/core";
import { DrawCore } from "@/components/drawCore";
import { withCanvasHistory } from "@/components/drawCore/components/historyContext";
import {
	type DrawCoreActionType,
	DrawCoreContext,
	type DrawCoreContextValue,
	DrawStatePublisher,
	ExcalidrawEventPublisher,
	ExcalidrawOnHandleEraserPublisher,
} from "@/components/drawCore/extra";
import type { ImageLayerActionType } from "@/components/imageLayer";
import { withStatePublisher } from "@/hooks/useStatePublisher";
import { useStateRef } from "@/hooks/useStateRef";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { EnableKeyEventPublisher } from "@/pages/draw/components/drawToolbar/components/keyEventWrap/extra";
import type { SelectRectParams } from "@/pages/draw/components/selectLayer";
import {
	DrawContext,
	type DrawContextType,
} from "@/pages/fullScreenDraw/extra";
import type { ElementRect } from "@/types/commands/screenshot";
import { DrawState } from "@/types/draw";
import { MousePosition } from "@/utils/mousePosition";
import { zIndexs } from "@/utils/zIndex";
import type { FixedContentInitDrawParams, FixedContentWindowSize } from "../..";
import {
	BOX_SHADOW_WIDTH,
	FixedContentCoreDrawToolbar,
	type FixedContentCoreDrawToolbarActionType,
} from "./toolbar";

export type FixedContentCoreDrawActionType = {
	getToolbarSize: () => { width: number; height: number };
	getDrawMenuSize: () => { width: number; height: number };
	getCanvas: () => HTMLCanvasElement | null;
	tryRenderElements: () => Promise<void>;
	clearElements: () => void;
};

const DRAW_MENU_WIDTH = 200;
const DRAW_MENU_HEIGHT = 300;

const DrawLayerCore: React.FC<{
	actionRef: React.RefObject<FixedContentCoreDrawActionType | undefined>;
	documentSize: FixedContentWindowSize;
	scaleInfo: {
		x: number;
		y: number;
	};
	disabled?: boolean;
	hidden?: boolean;
	onConfirm: () => void;
	getImageLayerAction: () => ImageLayerActionType | undefined;
	getSelectRectParams: () => SelectRectParams | undefined;
	getInitDrawSelectRectParams: () => SelectRectParams | undefined;
	getInitDrawDrawElements: () =>
		| FixedContentInitDrawParams["drawElements"]
		| undefined;
	getInitDrawWindowDevicePixelRatio: () => number | undefined;
	getZoom: () => number;
	switchDraw: () => void;
	isImageLayerReady: () => boolean;
	onCrop?: () => void;
	/** 内容在窗口内的偏移（CSS 像素），编辑全屏时内容不在窗口原点 */
	contentOffset?: { x: number; y: number };
}> = ({
	actionRef,
	documentSize,
	scaleInfo,
	disabled,
	hidden,
	onConfirm,
	getImageLayerAction,
	getSelectRectParams,
	getInitDrawSelectRectParams,
	getInitDrawDrawElements,
	getInitDrawWindowDevicePixelRatio,
	getZoom,
	switchDraw,
	isImageLayerReady,
	onCrop,
	contentOffset,
}) => {
	const { token } = theme.useToken();

	const drawToolbarActionRef = useRef<
		FixedContentCoreDrawToolbarActionType | undefined
	>(undefined);
	const drawCoreActionRef = useRef<DrawCoreActionType | undefined>(undefined);
	const [, setEnableKeyEvent] = useStateSubscriber(
		EnableKeyEventPublisher,
		undefined,
	);

	const documentSizeRef = useRef(documentSize);
	useEffect(() => {
		documentSizeRef.current = documentSize;
	}, [documentSize]);
	const scaleInfoRef = useRef(scaleInfo);
	useEffect(() => {
		scaleInfoRef.current = scaleInfo;
	}, [scaleInfo]);

	const [excalidrawReady, setExcalidrawReady, excalidrawReadyRef] =
		useStateRef(false);

	const mousePositionRef = useRef<MousePosition | undefined>(undefined);
	useEffect(() => {
		const onMouseMove = (ev: MouseEvent) => {
			mousePositionRef.current = new MousePosition(ev.clientX, ev.clientY);
		};

		document.addEventListener("mousemove", onMouseMove);

		return () => {
			document.removeEventListener("mousemove", onMouseMove);
		};
	}, []);

	const getDrawMenuSize = useCallback(() => {
		return {
			width: DRAW_MENU_WIDTH + 3 * 2,
			height: DRAW_MENU_HEIGHT + 3 * 2 + 36,
		};
	}, []);

	const [toolbarEnable, setToolbarEnable] = useState(false);
	const currentindowContext = useRef<
		| {
				monitorBounds: MonitorBoundingBox | undefined;
				windowSize: PhysicalSize;
				windowPosition: PhysicalPosition;
		  }
		| undefined
	>(undefined);
	const activeToolbar = useCallback(async () => {
		const appWindow = getCurrentWindow();
		const [windowSize, windowPosition] = await Promise.all([
			appWindow.outerSize(),
			appWindow.outerPosition(),
		]);
		const points = [
			[
				Math.round(windowPosition.x + windowSize.width / 2),
				Math.round(windowPosition.y + windowSize.height / 2),
			],
			[windowPosition.x, windowPosition.y],
			[
				windowPosition.x + windowSize.width,
				windowPosition.y + windowSize.height,
			],
			[windowPosition.x + windowSize.width, windowPosition.y],
			[windowPosition.x, windowPosition.y + windowSize.height],
		];

		let monitorBounds: MonitorBoundingBox | undefined;
		for (const point of points) {
			const bounds = await getMonitorsBoundingBox(
				{
					min_x: point[0],
					min_y: point[1],
					max_x: point[0],
					max_y: point[1],
				},
				false,
			);
			if (bounds.monitor_rect_list.length > 0) {
				monitorBounds = bounds;
				break;
			}
		}

		currentindowContext.current = {
			monitorBounds: monitorBounds,
			windowSize,
			windowPosition,
		};

		setToolbarEnable(true);
	}, []);

	const drawCoreContextValue = useMemo<DrawCoreContextValue>(() => {
		return {
			getLimitRect: () => {
				// limitRect 用于工具栏/绘制菜单的定位（视口坐标），
				// 编辑全屏时内容有偏移，需要把偏移计算在内
				const offsetX = (contentOffset?.x ?? 0) * window.devicePixelRatio;
				const offsetY = (contentOffset?.y ?? 0) * window.devicePixelRatio;
				return {
					min_x: offsetX,
					min_y: offsetY,
					max_x: offsetX + documentSize.width * window.devicePixelRatio,
					max_y: offsetY + documentSize.height * window.devicePixelRatio,
				};
			},
			getDevicePixelRatio: () => {
				return window.devicePixelRatio;
			},
			getBaseOffset: (limitRect: ElementRect, devicePixelRatio: number) => {
				return {
					x: limitRect.max_x / devicePixelRatio + token.marginXXS,
					y: limitRect.min_y / devicePixelRatio + 3,
				};
			},
			getAction: () => {
				return drawCoreActionRef.current;
			},
			getMousePosition: () => {
				return mousePositionRef.current;
			},
			calculatedBoundaryRect: (
				rect: ElementRect,
				toolbarWidth: number,
				toolbarHeight: number,
			) => {
				if (
					!currentindowContext.current ||
					!currentindowContext.current.monitorBounds
				) {
					return {
						min_x: rect.min_x + BOX_SHADOW_WIDTH,
						min_y: rect.min_y + BOX_SHADOW_WIDTH,
						max_x: rect.max_x - BOX_SHADOW_WIDTH,
						max_y: rect.max_y - BOX_SHADOW_WIDTH,
					};
				}

				// 获取窗口相对显示器的左上角
				let contentMinX = Math.max(
					currentindowContext.current.windowPosition.x,
					currentindowContext.current.monitorBounds.rect.min_x,
				);
				let contentMinY = Math.max(
					currentindowContext.current.windowPosition.y,
					currentindowContext.current.monitorBounds.rect.min_y,
				);
				// 获取窗口相对显示器的右下角
				let contentMaxX = Math.min(
					currentindowContext.current.windowPosition.x +
						currentindowContext.current.windowSize.width,
					currentindowContext.current.monitorBounds.rect.max_x,
				);
				let contentMaxY = Math.min(
					currentindowContext.current.windowPosition.y +
						currentindowContext.current.windowSize.height,
					currentindowContext.current.monitorBounds.rect.max_y,
				);

				const toolbarPhysicalWidth = toolbarWidth * window.devicePixelRatio + 9;
				const toolbarPhysicalHeight =
					toolbarHeight * window.devicePixelRatio + 9;
				if (contentMaxX - contentMinX < toolbarPhysicalWidth) {
					if (
						contentMaxX === currentindowContext.current.monitorBounds.rect.max_x
					) {
						contentMaxX = contentMinX + toolbarPhysicalWidth;
					} else {
						contentMinX = contentMaxX - toolbarPhysicalWidth;
					}
				}

				if (contentMaxY - contentMinY < toolbarPhysicalHeight) {
					if (
						contentMaxY === currentindowContext.current.monitorBounds.rect.max_y
					) {
						contentMaxY = contentMinY + toolbarPhysicalHeight;
					} else {
						contentMinY = contentMaxY - toolbarPhysicalHeight;
					}
				}

				const minXOffset =
					(contentMinX - currentindowContext.current.windowPosition.x) /
					window.devicePixelRatio;
				const minYOffset =
					(contentMinY - currentindowContext.current.windowPosition.y) /
					window.devicePixelRatio;
				const maxXOffset =
					document.body.clientWidth -
					(contentMaxX - currentindowContext.current.windowPosition.x) /
						window.devicePixelRatio;
				const maxYOffset =
					document.body.clientHeight -
					(contentMaxY - currentindowContext.current.windowPosition.y) /
						window.devicePixelRatio;

				return {
					min_x: rect.min_x + minXOffset + BOX_SHADOW_WIDTH,
					min_y: rect.min_y + minYOffset + BOX_SHADOW_WIDTH,
					max_x: rect.max_x - maxXOffset - BOX_SHADOW_WIDTH,
					max_y: rect.max_y - maxYOffset - BOX_SHADOW_WIDTH,
				};
			},
		};
	}, [
		documentSize.height,
		documentSize.width,
		token.marginXXS,
		contentOffset?.x,
		contentOffset?.y,
	]);

	const drawContextValue = useMemo<DrawContextType>(() => {
		return {
			getDrawCoreAction: () => drawCoreActionRef.current,
			setTool: (drawState: DrawState) => {
				drawToolbarActionRef.current?.setTool(drawState);
			},
			getImageLayerAction,
			getDrawLayerAction: () => drawCoreActionRef.current,
			getSelectRectParams,
			getZoom: getZoom,
		};
	}, [getImageLayerAction, getSelectRectParams, getZoom]);

	const onMouseEvent = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			event.preventDefault();
			event.stopPropagation();
		},
		[],
	);

	useEffect(() => {
		setEnableKeyEvent(!(disabled ?? false));
	}, [disabled, setEnableKeyEvent]);

	const baseZoomRef = useRef<number>(1);

	useEffect(() => {
		if (!drawCoreActionRef.current) {
			return;
		}

		const appState = drawCoreActionRef.current?.getAppState();
		if (!appState) {
			return;
		}

		drawCoreActionRef.current?.updateScene({
			appState: {
				scrollX: appState.scrollX,
				scrollY: appState.scrollY,
				zoom: {
					value: (baseZoomRef.current *
						(scaleInfo.x / 100)) as NormalizedZoomValue,
				},
			},
			captureUpdate: "NEVER",
		});
	}, [scaleInfo.x]);

	useEffect(() => {
		if (disabled) {
			drawCoreActionRef.current?.finishDraw();
			drawToolbarActionRef.current?.setTool(DrawState.Select);
			setToolbarEnable(false);
		} else {
			activeToolbar();
		}
	}, [disabled, activeToolbar]);

	const tryRenderElements = useCallback(async () => {
		if (!excalidrawReadyRef.current || !isImageLayerReady()) {
			return;
		}

		// 初始化元素
		const shadowWidth = getInitDrawSelectRectParams()?.shadowWidth ?? 0;
		const selectRect = getInitDrawSelectRectParams()?.rect ?? {
			min_x: 0,
			min_y: 0,
			max_x: documentSizeRef.current.width,
			max_y: documentSizeRef.current.height,
		};
		const elements = getInitDrawDrawElements()?.elements ?? [];

		if (elements.length === 0) {
			return;
		}

		const initDrawWindowDevicePixelRatio =
			getInitDrawWindowDevicePixelRatio() ?? window.devicePixelRatio;
		const scaleFactorRatio =
			initDrawWindowDevicePixelRatio / window.devicePixelRatio;
		baseZoomRef.current =
			scaleFactorRatio * (getInitDrawDrawElements()?.zoom ?? 1);

		const baseOffsetX =
			(selectRect.min_x - shadowWidth) / initDrawWindowDevicePixelRatio;
		const baseOffsetY =
			(selectRect.min_y - shadowWidth) / initDrawWindowDevicePixelRatio;

		drawCoreActionRef.current?.updateScene({
			elements: elements.map((element): ExcalidrawElement => {
				return {
					...element,
					x: element.x - baseOffsetX / (getInitDrawDrawElements()?.zoom ?? 1),
					y: element.y - baseOffsetY / (getInitDrawDrawElements()?.zoom ?? 1),
					width: element.width,
					height: element.height,
				};
			}),
			appState: {
				scrollX: getInitDrawDrawElements()?.scrollX ?? 0,
				scrollY: getInitDrawDrawElements()?.scrollY ?? 0,
				zoom: {
					value: baseZoomRef.current as NormalizedZoomValue,
				},
			},
		});
	}, [
		getInitDrawSelectRectParams,
		getInitDrawDrawElements,
		getInitDrawWindowDevicePixelRatio,
		excalidrawReadyRef,
		isImageLayerReady,
	]);

	const excalidrawHasLoadRef = useRef(false);
	const excalidrawAppStateStoreReadyRef = useRef(false);
	const tryShowExcalidraw = useCallback(async () => {
		if (
			!excalidrawHasLoadRef.current ||
			!excalidrawAppStateStoreReadyRef.current
		) {
			return;
		}
		setExcalidrawReady(true);

		tryRenderElements();
	}, [tryRenderElements, setExcalidrawReady]);

	useImperativeHandle(actionRef, () => {
		return {
			getToolbarSize: () => {
				return (
					drawToolbarActionRef.current?.getSize() ?? {
						width: 0,
						height: 0,
					}
				);
			},
			getDrawMenuSize,
			getCanvas: () => {
				if (
					drawCoreActionRef.current?.getExcalidrawAPI()?.getSceneElements()
						.length === 0
				) {
					return null;
				}

				return drawCoreActionRef.current?.getCanvas() ?? null;
			},
			tryRenderElements,
			clearElements: () => {
				drawCoreActionRef.current?.updateScene({ elements: [] });
			},
		};
	}, [getDrawMenuSize, tryRenderElements]);

	return (
		<DrawContext.Provider value={drawContextValue}>
			<div
				className="fixed-content-draw-layer"
				onMouseDown={onMouseEvent}
				onClick={onMouseEvent}
				onDoubleClick={onMouseEvent}
			>
				<DrawCoreContext.Provider value={drawCoreContextValue}>
					<Suspense>
						<DrawCore
							actionRef={drawCoreActionRef}
							zIndex={zIndexs.Draw_DrawCacheLayer}
							layoutMenuZIndex={zIndexs.Draw_ExcalidrawToolbar}
							appStateStorageKey={"fixed-content-draw-layer"}
							onLoad={() => {
								excalidrawHasLoadRef.current = true;
								tryShowExcalidraw();
							}}
							onAppStateStoreReady={() => {
								excalidrawAppStateStoreReadyRef.current = true;
								tryShowExcalidraw();
							}}
						/>
					</Suspense>
					<FixedContentCoreDrawToolbar
						actionRef={drawToolbarActionRef}
						disabled={!toolbarEnable}
						documentSize={documentSize}
						onConfirm={onConfirm}
						switchDraw={switchDraw}
						onCrop={onCrop}
					/>
				</DrawCoreContext.Provider>

				<style jsx>{`
                    .fixed-content-draw-layer {
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: ${documentSize.width}px;
                        height: ${documentSize.height}px;
                        pointer-events: ${disabled ? "none" : "auto"};
                    }

                    .fixed-content-draw-layer :global(.draw-core-layer .excalidraw) {
                        opacity: ${excalidrawReady && !hidden ? 1 : 0};
                    }

                    .fixed-content-draw-layer :global(.Island.App-menu__left) {
                        max-height: ${Math.max(documentSize.height + 19, DRAW_MENU_HEIGHT + 15)}px !important;
                    }
                `}</style>
			</div>
		</DrawContext.Provider>
	);
};

export const DrawLayer = withCanvasHistory(
	withStatePublisher(
		DrawLayerCore,
		DrawStatePublisher,
		ExcalidrawEventPublisher,
		EnableKeyEventPublisher,
		ExcalidrawOnHandleEraserPublisher,
	),
);
