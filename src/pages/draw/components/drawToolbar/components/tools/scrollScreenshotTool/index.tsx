import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button, Spin, theme } from "antd";
import type { MessageType } from "antd/es/message/interface";
import { debounce, throttle } from "es-toolkit";
import {
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	type WheelEventHandler,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
	autoScrollThrough,
	clickThrough,
	scrollThrough,
} from "@/commands/core";
import { listenMouseStart, listenMouseStop } from "@/commands/listenKey";
import {
	SCROLL_SCREENSHOT_CAPTURE_RESULT_EXTRA_DATA_SIZE,
	ScrollDirection,
	ScrollImageList,
	type ScrollScreenshotCaptureResult,
	scrollScreenshotCapture,
	scrollScreenshotClear,
	scrollScreenshotHandleImage,
	scrollScreenshotInit,
} from "@/commands/scrollScreenshot";
import { DrawStatePublisher } from "@/components/drawCore/extra";
import { EventListenerContext } from "@/components/eventListener";
import { RotateIcon } from "@/components/icons";
import { LISTEN_KEY_SERVICE_MOUSE_DOWN_EMIT_KEY } from "@/constants/eventListener";
import { AntdContext } from "@/contexts/antdContext";
import { AppSettingsPublisher } from "@/contexts/appSettingsActionContext";
import { useStateRef } from "@/hooks/useStateRef";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { useMonitorRect } from "@/pages/draw/components/statusBar";
import { DrawEvent, DrawEventPublisher } from "@/pages/draw/extra";
import { DrawContext } from "@/pages/draw/types";
import { AppSettingsGroup } from "@/types/appSettings";
import type { ElementRect } from "@/types/commands/screenshot";
import { DrawState } from "@/types/draw";
import { getCorrectHdrColorAlgorithm } from "@/utils/appSettings";
import { appError, appWarn } from "@/utils/log";
import { getPlatform } from "@/utils/platform";
import { zIndexs } from "@/utils/zIndex";
import { SubTools, type SubToolsActionType } from "../../subTools";

const THUMBNAIL_WIDTH = 128;

export type ScrollScreenshotActionType = {
	getScrollScreenshotSubToolContainer: () => HTMLDivElement | null | undefined;
};

type ImageUrl = {
	url: string;
	overlaySize: number;
};

export const ScrollScreenshot: React.FC<{
	actionRef: React.RefObject<ScrollScreenshotActionType | undefined>;
}> = ({ actionRef }) => {
	const { message } = useContext(AntdContext);
	const intl = useIntl();
	const { token } = theme.useToken();

	const {
		contentScale: [contentScale],
	} = useMonitorRect(false);

	const monitorThumbnailWidth = useMemo(() => {
		return THUMBNAIL_WIDTH * contentScale;
	}, [contentScale]);

	const [, setDrawEvent] = useStateSubscriber(DrawEventPublisher, undefined);

	const [loading, setLoading] = useState(false);
	const { selectLayerActionRef, captureBoundingBoxInfoRef } =
		useContext(DrawContext);
	const [positionRect, setPositionRect, positionRectRef] = useStateRef<
		ElementRect | undefined
	>(undefined);
	const [getAppSettings] = useStateSubscriber(AppSettingsPublisher, undefined);

	const enableScrollThroughRef = useRef(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	const [topImageUrlList, setTopImageUrlList, topImageUrlListRef] = useStateRef<
		ImageUrl[]
	>([]);
	const [bottomImageUrlList, setBottomImageUrlList, bottomImageUrlListRef] =
		useStateRef<ImageUrl[]>([]);

	const releaseImageUrlList = useCallback(() => {
		topImageUrlListRef.current.forEach((imageUrl) => {
			URL.revokeObjectURL(imageUrl.url);
		});
		bottomImageUrlListRef.current.forEach((imageUrl) => {
			URL.revokeObjectURL(imageUrl.url);
		});
		setTopImageUrlList([]);
		setBottomImageUrlList([]);
	}, [
		setBottomImageUrlList,
		setTopImageUrlList,
		topImageUrlListRef,
		bottomImageUrlListRef,
	]);
	useEffect(() => {
		return releaseImageUrlList;
	}, [releaseImageUrlList]);

	const [captuerEdgePosition, setCaptuerEdgePosition] = useState<
		"top" | "bottom"
	>("top");

	const [scrollDirection, setScrollDirection, scrollDirectionRef] =
		useStateRef<ScrollDirection>(ScrollDirection.Vertical);

	const scrollTo = useMemo(() => {
		return debounce((value: number) => {
			if (!scrollRef.current) {
				appWarn("[scrollTo] scrollRef.current is undefined");
				return;
			}

			scrollRef.current.scrollTo(
				scrollDirectionRef.current === ScrollDirection.Horizontal
					? {
							left: value,
							behavior: "smooth",
						}
					: {
							top: value,
							behavior: "smooth",
						},
			);
		}, 64);
	}, [scrollDirectionRef]);

	const updateImageUrlList = useCallback(
		(captureResult: ScrollScreenshotCaptureResult) => {
			if (captureResult.thumbnail_buffer === undefined) {
				return;
			}

			const currentScrollSize = {
				top_image_size: captureResult.top_image_size,
				bottom_image_size: captureResult.bottom_image_size,
			};

			const edgePosition = captureResult.edge_position ?? 0;

			if (!positionRectRef.current) {
				appWarn("[updateImageUrlList] positionRectRef.current is undefined");
				return;
			}

			let positionScale: number;
			if (scrollDirectionRef.current === ScrollDirection.Horizontal) {
				positionScale =
					monitorThumbnailWidth /
					((positionRectRef.current.max_y - positionRectRef.current.min_y) *
						window.devicePixelRatio);
			} else {
				positionScale =
					monitorThumbnailWidth /
					((positionRectRef.current.max_x - positionRectRef.current.min_x) *
						window.devicePixelRatio);
			}
			const thumbnailHeight =
				scrollDirectionRef.current === ScrollDirection.Horizontal
					? (monitorThumbnailWidth *
							(positionRectRef.current.max_x - positionRectRef.current.min_x)) /
						(positionRectRef.current.max_y - positionRectRef.current.min_y)
					: (monitorThumbnailWidth *
							(positionRectRef.current.max_y - positionRectRef.current.min_y)) /
						(positionRectRef.current.max_x - positionRectRef.current.min_x);

			let captuerEdge =
				currentScrollSize.top_image_size ?? 0 + (edgePosition ?? 0);
			if (edgePosition > 0) {
				captuerEdge -= thumbnailHeight / positionScale;
			}

			// 用百分比计算，避免误差
			setCaptuerEdgePosition(edgePosition > 0 ? "bottom" : "top");

			if (
				captureResult.thumbnail_buffer.byteLength <=
				SCROLL_SCREENSHOT_CAPTURE_RESULT_EXTRA_DATA_SIZE
			) {
				scrollTo(Math.max(captuerEdge, 0));
				return;
			}

			const blobUrl = URL.createObjectURL(
				new Blob([captureResult.thumbnail_buffer]),
			);

			const overlaySize = captureResult.overlay_size ?? 0;
			if (captureResult.current_direction === ScrollImageList.Top) {
				setTopImageUrlList((prev) => [{ url: blobUrl, overlaySize }, ...prev]);
				setTimeout(() => {
					scrollTo(0);
				}, 100);
			} else {
				setBottomImageUrlList((prev) => [
					...prev,
					{ url: blobUrl, overlaySize },
				]);
				setTimeout(() => {
					scrollTo(
						scrollDirectionRef.current === ScrollDirection.Horizontal
							? (scrollRef.current?.scrollWidth ?? 0)
							: (scrollRef.current?.scrollHeight ?? 0),
					);
				}, 100);
			}
		},
		[
			monitorThumbnailWidth,
			positionRectRef,
			scrollDirectionRef,
			scrollTo,
			setBottomImageUrlList,
			setTopImageUrlList,
		],
	);

	const lastCaptureMissHideRef = useRef<MessageType | undefined>(undefined);

	const pendingEnableAutoScrollThroughClickRef = useRef<boolean>(false);
	const setPendingEnableAutoScrollThroughClickRef = useRef<
		NodeJS.Timeout | undefined
	>(undefined);
	const autoScrollThroughIntervalRef = useRef<NodeJS.Timeout | undefined>(
		undefined,
	);

	const stopAutoScrollThrough = useCallback((clearDelay: number = 300) => {
		if (autoScrollThroughIntervalRef.current) {
			clearInterval(autoScrollThroughIntervalRef.current);
			if (clearDelay > 0) {
				autoScrollThroughIntervalRef.current = setTimeout(() => {
					autoScrollThroughIntervalRef.current = undefined;
					pendingEnableAutoScrollThroughClickRef.current = false;
				}, clearDelay);
			} else {
				autoScrollThroughIntervalRef.current = undefined;
				pendingEnableAutoScrollThroughClickRef.current = false;
			}

			listenMouseStop();
			return true;
		}
		return false;
	}, []);

	const showCaptureMissMessage = useMemo(() => {
		return throttle(
			() => {
				if (lastCaptureMissHideRef.current) {
					try {
						lastCaptureMissHideRef.current();
					} catch {}
				}

				if (autoScrollThroughIntervalRef.current) {
					return;
				}

				lastCaptureMissHideRef.current = message.warning(
					intl.formatMessage({ id: "draw.scrollScreenshot.captureMiss" }),
				);
			},
			3000,
			{ edges: ["leading"] },
		);
	}, [intl, message]);

	const setLoadingDebounce = useMemo(() => {
		return debounce(setLoading, 256);
	}, []);

	// 判断是否连续多次没有变化
	const noChangeCount = useRef(0);
	/**
	 * @returns 是否需要继续处理
	 */
	const handleCaptureImage = useCallback(async (): Promise<boolean> => {
		setLoading(true);
		let captureResult: ScrollScreenshotCaptureResult;

		let needContinue = false;

		try {
			captureResult = await scrollScreenshotHandleImage(
				Math.round(monitorThumbnailWidth * window.devicePixelRatio),
			);
		} catch (error) {
			appError("[handleCaptureImage] scrollScreenshotHandleImage error", error);
			message.error(
				intl.formatMessage({ id: "draw.scrollScreenshot.captureError" }),
			);
			return needContinue;
		}

		needContinue = captureResult.type !== "no_image";

		if (
			captureResult.type === "no_change" ||
			captureResult.type === "no_data"
		) {
			noChangeCount.current++;
		}

		if (noChangeCount.current > 3) {
			noChangeCount.current = 0;
			stopAutoScrollThrough();
		}

		setLoadingDebounce(false);

		if (captureResult.type === "no_image") {
			return needContinue;
		} else if (
			captureResult.edge_position === 0 &&
			captureResult.thumbnail_buffer === undefined
		) {
			return needContinue;
		} else if (captureResult.edge_position === undefined) {
			showCaptureMissMessage();
			return needContinue;
		}

		noChangeCount.current = 0;
		updateImageUrlList(captureResult);

		return needContinue;
	}, [
		setLoadingDebounce,
		updateImageUrlList,
		monitorThumbnailWidth,
		message,
		intl,
		stopAutoScrollThrough,
		showCaptureMissMessage,
	]);

	const pendingCaptureImageListRef = useRef<boolean>(false);
	const handleCaptureImageList = useCallback(async () => {
		if (pendingCaptureImageListRef.current) {
			return;
		}
		pendingCaptureImageListRef.current = true;

		let needContinue = true;
		while (needContinue) {
			try {
				needContinue = await handleCaptureImage();
			} catch (error) {
				appError("[handleCaptureImageList] error", error);
				break;
			}
		}

		pendingCaptureImageListRef.current = false;
	}, [handleCaptureImage]);

	const handleCaptureImageListDebounce = useMemo(() => {
		return debounce(handleCaptureImageList, 100);
	}, [handleCaptureImageList]);

	const captureImageCore = useCallback(
		async (scrollImageList: ScrollImageList) => {
			const selectRect = selectLayerActionRef.current?.getSelectRect();
			if (!captureBoundingBoxInfoRef.current || !selectRect) {
				appWarn(
					"[captureImageCore] captureBoundingBoxInfoRef.current or selectLayerActionRef.current is undefined",
				);
				return;
			}

			const rect =
				captureBoundingBoxInfoRef.current.transformWindowRect(selectRect);

			setDrawEvent({
				event: DrawEvent.ScrollScreenshot,
				params: undefined,
			});
			setDrawEvent(undefined);

			// 等待 1 帧，确保取色器、工具栏隐藏
			await new Promise((resolve) => setTimeout(resolve, 17));

			await scrollScreenshotCapture(
				scrollImageList,
				rect.min_x,
				rect.min_y,
				rect.max_x,
				rect.max_y,
				getCorrectHdrColorAlgorithm(getAppSettings()),
				getAppSettings()[AppSettingsGroup.SystemScreenshot].correctColorFilter,
			);

			handleCaptureImageListDebounce();
		},
		[
			captureBoundingBoxInfoRef,
			selectLayerActionRef,
			setDrawEvent,
			handleCaptureImageListDebounce,
			getAppSettings,
		],
	);

	const captureImageDebounce = useMemo(() => {
		return debounce(captureImageCore, 256);
	}, [captureImageCore]);
	const captureImage = useMemo(() => {
		return throttle(
			(scrollImageList: ScrollImageList) => {
				captureImageCore(scrollImageList);
				captureImageDebounce(scrollImageList);
			},
			32,
			{ edges: ["leading", "trailing"] },
		);
	}, [captureImageCore, captureImageDebounce]);

	const [showTip, _setShowTip] = useState(false);
	const touchAreaTipRef = useRef<HTMLDivElement>(null);
	const setShowTip = useCallback((show: boolean) => {
		_setShowTip(show);
		if (touchAreaTipRef.current) {
			touchAreaTipRef.current.style.opacity = show ? "1" : "0";
		}
	}, []);
	const init = useCallback(
		async (rect: ElementRect, direction: ScrollDirection) => {
			const scale = 1 / window.devicePixelRatio;
			setPositionRect({
				min_x: rect.min_x * scale,
				min_y: rect.min_y * scale,
				max_x: rect.max_x * scale,
				max_y: rect.max_y * scale,
			});
			setShowTip(
				getAppSettings()[AppSettingsGroup.FunctionScreenshot]
					.longScreenshotAutoScroll,
			);

			const scrollSettings =
				getAppSettings()[AppSettingsGroup.SystemScrollScreenshot];
			const maxSide = Math.max(scrollSettings.maxSide, scrollSettings.minSide);

			try {
				await scrollScreenshotClear();
				await scrollScreenshotInit(
					direction,
					rect.max_x - rect.min_x,
					rect.max_y - rect.min_y,
					scrollSettings.sampleRate,
					scrollSettings.minSide,
					maxSide,
					scrollSettings.imageFeatureThreshold,
					scrollSettings.imageFeatureDescriptionLength,
					scrollDirectionRef.current === ScrollDirection.Horizontal
						? Math.ceil((rect.max_x - rect.min_x) * 0.8)
						: Math.ceil((rect.max_y - rect.min_y) * 0.8),
					scrollSettings.tryRollback,
				);
			} catch (error) {
				appError("[init] scrollScreenshotInit error", error);
				message.error(
					intl.formatMessage({ id: "draw.scrollScreenshot.initError" }),
				);
				return;
			}

			enableScrollThroughRef.current = true;
		},
		[
			setPositionRect,
			getAppSettings,
			scrollDirectionRef,
			message,
			intl,
			setShowTip,
		],
	);

	const pendingScrollThroughRef = useRef<boolean>(false);

	const enableCursorEventsDebounce = useMemo(() => {
		return debounce(
			() => {
				const appWindow = getCurrentWindow();
				appWindow.setIgnoreCursorEvents(false);
			},
			128 + 128 + 16,
		);
	}, []);

	const onWheel = useCallback<WheelEventHandler<HTMLDivElement>>(
		(event) => {
			if (autoScrollThroughIntervalRef.current) {
				return;
			}

			if (!enableScrollThroughRef.current) {
				return;
			}

			// 无论当前是否可见，直接强制隐藏，并且不要设置 setTimeout 把它变回来，一旦开始滚动，提示就应该消失。
			setShowTip(false);

			// 直接执行截图逻辑，这里的 captureImage 内部调用的 captureImageCore 已经包含了 17ms 的等待，足够让上面的 setShowTip(false) 生效并完成渲染，所以这里直接调用即可。
			captureImage(
				event.deltaY > 0 ? ScrollImageList.Bottom : ScrollImageList.Top,
			);

			if (!pendingScrollThroughRef.current) {
				if (
					scrollDirectionRef.current === ScrollDirection.Horizontal &&
					!event.shiftKey
				) {
					return;
				}

				// 加一个冗余操作，防止鼠标事件被忽略
				enableCursorEventsDebounce();
				pendingScrollThroughRef.current = true;
				scrollThrough(event.deltaY > 0 ? 1 : -1)
					.catch(() => {
						message.warning(
							<FormattedMessage id="draw.scrollScreenshot.scrollError" />,
						);
					})
					.finally(() => {
						pendingScrollThroughRef.current = false;
					});
			}
		},
		[
			captureImage,
			enableCursorEventsDebounce,
			message,
			scrollDirectionRef,
			setShowTip,
		],
	);

	const tryEnableAutoScrollThroughCore = useCallback(() => {
		if (pendingEnableAutoScrollThroughClickRef.current) {
			listenMouseStop();
			pendingEnableAutoScrollThroughClickRef.current = false;
		} else {
			listenMouseStart();
			if (setPendingEnableAutoScrollThroughClickRef.current) {
				clearTimeout(setPendingEnableAutoScrollThroughClickRef.current);
			}
			pendingEnableAutoScrollThroughClickRef.current = true;
			setPendingEnableAutoScrollThroughClickRef.current = setTimeout(
				async () => {
					if (pendingEnableAutoScrollThroughClickRef.current) {
						if (autoScrollThroughIntervalRef.current) {
							clearInterval(autoScrollThroughIntervalRef.current);
						}
						await getCurrentWindow().setIgnoreCursorEvents(true);
						pendingEnableAutoScrollThroughClickRef.current = false;
						autoScrollThroughIntervalRef.current = setInterval(async () => {
							await getCurrentWindow().setIgnoreCursorEvents(true);
							await autoScrollThrough(
								scrollDirectionRef.current === ScrollDirection.Horizontal
									? "horizontal"
									: "vertical",
								getPlatform() === "windows" ? 1 : 1,
							);
							enableCursorEventsDebounce();
							captureImageCore(ScrollImageList.Bottom);
						}, 150);
					}
					setPendingEnableAutoScrollThroughClickRef.current = undefined;
				},
				300,
			);
		}
	}, [captureImageCore, enableCursorEventsDebounce, scrollDirectionRef]);

	const { addListener, removeListener } = useContext(EventListenerContext);
	useEffect(() => {
		const listenerId = addListener(
			LISTEN_KEY_SERVICE_MOUSE_DOWN_EMIT_KEY,
			() => {
				if (pendingEnableAutoScrollThroughClickRef.current) {
					tryEnableAutoScrollThroughCore();
				} else {
					stopAutoScrollThrough(300);
				}
			},
		);
		return () => {
			removeListener(listenerId);
		};
	}, [
		addListener,
		removeListener,
		stopAutoScrollThrough,
		tryEnableAutoScrollThroughCore,
	]);

	const enableIgnoreCursorEventsRef = useRef(false);
	const onClick = useCallback(async () => {
		setShowTip(false);
		if (stopAutoScrollThrough()) {
			return;
		}

		if (enableIgnoreCursorEventsRef.current) {
			return;
		}

		if (
			!getAppSettings()[AppSettingsGroup.FunctionScreenshot]
				.longScreenshotAutoScroll
		) {
			// 已关闭滚动截图单击自动滚动，不启动自动滚动
			return;
		}

		tryEnableAutoScrollThroughCore();

		enableIgnoreCursorEventsRef.current = true;
		await clickThrough();
		enableIgnoreCursorEventsRef.current = false;
	}, [stopAutoScrollThrough, tryEnableAutoScrollThroughCore, setShowTip]);

	const startCapture = useCallback(async () => {
		enableScrollThroughRef.current = false;
		releaseImageUrlList();
		setPositionRect(undefined);

		const selectRect = selectLayerActionRef.current?.getSelectRect();
		if (!selectRect) {
			return;
		}

		init(selectRect, scrollDirectionRef.current);
		if (process.env.NODE_ENV === "development") {
			getCurrentWindow().setAlwaysOnTop(false);
		}
	}, [
		releaseImageUrlList,
		selectLayerActionRef,
		init,
		scrollDirectionRef,
		setPositionRect,
	]);

	const clearContext = useCallback(() => {
		if (autoScrollThroughIntervalRef.current) {
			clearInterval(autoScrollThroughIntervalRef.current);
		}
		if (setPendingEnableAutoScrollThroughClickRef.current) {
			clearTimeout(setPendingEnableAutoScrollThroughClickRef.current);
		}
		listenMouseStop();
	}, []);

	useStateSubscriber(
		DrawStatePublisher,
		useCallback(
			(drawState: DrawState) => {
				if (drawState !== DrawState.ScrollScreenshot) {
					setPositionRect(undefined);
					clearContext();
					return;
				}

				startCapture();
			},
			[setPositionRect, startCapture, clearContext],
		),
	);

	useEffect(() => {
		return () => {
			clearContext();
		};
	}, [clearContext]);

	const subToolsActionRef = useRef<SubToolsActionType>(undefined);
	useImperativeHandle(
		actionRef,
		useCallback(() => {
			return {
				getScrollScreenshotSubToolContainer: () =>
					subToolsActionRef.current?.getSubToolContainer(),
			};
		}, []),
	);

	if (!positionRect) {
		return null;
	}

	const thumbnailHeight =
		scrollDirection === ScrollDirection.Horizontal
			? (monitorThumbnailWidth * (positionRect.max_x - positionRect.min_x)) /
				(positionRect.max_y - positionRect.min_y)
			: (monitorThumbnailWidth * (positionRect.max_y - positionRect.min_y)) /
				(positionRect.max_x - positionRect.min_x);

	const thumbnailListTransform =
		scrollDirection === ScrollDirection.Horizontal
			? `translate(${positionRect.min_x}px, ${positionRect.min_y - token.marginXS - monitorThumbnailWidth}px) rotateX(180deg)`
			: `translate(${positionRect.max_x + token.marginXS}px, ${positionRect.min_y}px)`;

	return (
		<>
			<SubTools
				actionRef={subToolsActionRef}
				buttons={[
					<Button
						disabled={loading}
						onClick={() => {
							if (scrollDirectionRef.current === ScrollDirection.Horizontal) {
								setScrollDirection(ScrollDirection.Vertical);
							} else {
								setScrollDirection(ScrollDirection.Horizontal);
							}
							startCapture();
						}}
						icon={<RotateIcon />}
						title={intl.formatMessage({
							id: "draw.scrollScreenshot.changeDirection",
						})}
						type={"text"}
						key="rotate"
					/>,
				]}
			/>

			<div
				className="scroll-screenshot-tool-touch-area"
				style={{
					transform: `translate(${positionRect.min_x}px, ${positionRect.min_y}px)`,
				}}
				onWheel={onWheel}
				onClick={(event) => {
					event.stopPropagation();
					event.preventDefault();
					onClick();
				}}
				onDoubleClick={(event) => {
					event.stopPropagation();
					event.preventDefault();
				}}
			>
				<div
					style={{
						width: positionRect.max_x - positionRect.min_x,
						height: positionRect.max_y - positionRect.min_y,
					}}
				>
					{showTip && (
						<div className="tip">
							<div>
								<FormattedMessage id="draw.scrollScreenshot.tip2" />
							</div>
						</div>
					)}
				</div>

				<div className="touch-area-tip-container" ref={touchAreaTipRef}>
					<div className="touch-area-tip">
						<FormattedMessage id="draw.scrollScreenshot.tip" />
					</div>
				</div>
			</div>

			<div
				className="thumbnail-list"
				style={{
					transform: thumbnailListTransform,
				}}
				ref={scrollRef}
			>
				<div
					className="thumbnail-list-content"
					style={
						scrollDirection === ScrollDirection.Horizontal
							? {
									width: positionRect.max_x - positionRect.min_x,
									height: monitorThumbnailWidth,
								}
							: {
									width: monitorThumbnailWidth,
									height: positionRect.max_y - positionRect.min_y,
								}
					}
				>
					<div className="thumbnail-list-content-scroll-area">
						{captuerEdgePosition !== undefined && (
							<div
								className="captuer-edge-mask"
								style={{
									position: "absolute",
									zIndex:
										bottomImageUrlList.length + topImageUrlList.length + 1,
								}}
							>
								<div
									className="captuer-edge-mask-top"
									style={
										scrollDirection === ScrollDirection.Horizontal
											? {
													height: "100%",
													width:
														captuerEdgePosition === "bottom"
															? `calc(${100}% - ${thumbnailHeight}px)`
															: "0%",
												}
											: {
													height:
														captuerEdgePosition === "bottom"
															? `calc(${100}% - ${thumbnailHeight}px)`
															: "0%",
													width: "100%",
												}
									}
								/>
								<div
									style={
										scrollDirection === ScrollDirection.Horizontal
											? {
													height: "100%",
													width: thumbnailHeight,
												}
											: {
													height: thumbnailHeight,
													width: "100%",
												}
									}
								/>
								<div
									className="captuer-edge-mask-bottom"
									style={
										scrollDirection === ScrollDirection.Horizontal
											? {
													height: "100%",
													width:
														captuerEdgePosition === "bottom"
															? "0%"
															: `calc(${100}% - ${thumbnailHeight}px)`,
												}
											: {
													height:
														captuerEdgePosition === "bottom"
															? "0%"
															: `calc(${100}% - ${thumbnailHeight}px)`,
													width: "100%",
												}
									}
								/>
							</div>
						)}
						{topImageUrlList.map((imageUrl, index) => (
							// eslint-disable-next-line @next/next/no-img-element
							<img
								className="thumbnail"
								key={imageUrl.url}
								src={imageUrl.url}
								// 越前的图片，层级越高，并且 topImageUrlList 大于 bottomImageUrlList
								style={{
									position: "relative",
									zIndex:
										bottomImageUrlList.length + topImageUrlList.length - index,
									...(scrollDirection === ScrollDirection.Vertical
										? {
												marginBottom:
													imageUrl.overlaySize / window.devicePixelRatio,
											}
										: {
												marginRight:
													imageUrl.overlaySize / window.devicePixelRatio,
											}),
								}}
								alt="top"
							/>
						))}
						{bottomImageUrlList.map((imageUrl, index) => (
							// eslint-disable-next-line @next/next/no-img-element
							<img
								className="thumbnail"
								key={imageUrl.url}
								src={imageUrl.url}
								// 越后的图片，层级越高
								style={{
									position: "relative",
									zIndex: index,
									...(scrollDirection === ScrollDirection.Vertical
										? {
												marginTop:
													-imageUrl.overlaySize / window.devicePixelRatio,
											}
										: {
												marginLeft:
													-imageUrl.overlaySize / window.devicePixelRatio,
											}),
								}}
								alt="bottom"
							/>
						))}
					</div>
				</div>
			</div>

			<div
				style={{
					transform: thumbnailListTransform,
					position: "fixed",
					left: 0,
					top: 0,
				}}
			>
				<Spin spinning={loading}>
					<div
						style={
							scrollDirection === ScrollDirection.Horizontal
								? {
										width: positionRect.max_x - positionRect.min_x,
										height: monitorThumbnailWidth,
									}
								: {
										width: monitorThumbnailWidth,
										height: positionRect.max_y - positionRect.min_y,
									}
						}
					/>
				</Spin>
			</div>

			<style jsx>{`
                .scroll-screenshot-tool-touch-area {
                    position: fixed;
                    left: 0px;
                    top: 0px;
                    z-index: ${zIndexs.Draw_ScrollScreenshotThumbnail};
                    pointer-events: auto;
                }

                .scroll-screenshot-tool-touch-area-content {
                    width: 100%;
                    height: 100%;
                }

                .scroll-screenshot-tool-touch-area .tip {
                    color: ${token.colorWhite};
                    text-align: center;
                    width: 100%;
                    transform: scale(${contentScale}) translateY(calc(-100% - ${token.marginXXS}px));
                    line-height: 1.2em;
                    pointer-events: none;
                }

                .thumbnail-list {
                    width: ${
											scrollDirection === ScrollDirection.Horizontal
												? "unset"
												: `${monitorThumbnailWidth + 5}px`
										};
                    height: ${
											scrollDirection === ScrollDirection.Horizontal
												? `${monitorThumbnailWidth + 5}px`
												: "unset"
										};
                    position: fixed;
                    left: 0px;
                    top: ${scrollDirection === ScrollDirection.Horizontal ? "-5px" : "0px"};
                    overflow-y: ${
											scrollDirection === ScrollDirection.Horizontal
												? "hidden"
												: "auto"
										};
                    overflow-x: ${
											scrollDirection === ScrollDirection.Horizontal
												? "auto"
												: "hidden"
										};
                    pointer-events: auto;
                    box-sizing: border-box;
                }

                .thumbnail-list::-webkit-scrollbar {
                    width: 5px;
                    height: 5px;
                }

                .thumbnail-list::-webkit-scrollbar-thumb {
                    background-color: rgba(0, 0, 0, 0.2);
                    border-radius: 4px;
                }

                .thumbnail-list::-webkit-scrollbar-thumb:hover {
                    background-color: rgba(0, 0, 0, 0.4);
                }

                .thumbnail-list::-webkit-scrollbar-track {
                    background: transparent;
                    border-radius: 4px;
                }

                .thumbnail-list .thumbnail {
                    width: ${
											scrollDirection === ScrollDirection.Horizontal
												? "unset"
												: `${monitorThumbnailWidth}px`
										};
                    height: ${
											scrollDirection === ScrollDirection.Horizontal
												? `${monitorThumbnailWidth}px`
												: "unset"
										};
                }

                .thumbnail-list-content {
                    position: relative;
                }

                .thumbnail-list-content-scroll-area {
                    display: flex;
                    flex-direction: ${
											scrollDirection === ScrollDirection.Horizontal
												? "row"
												: "column"
										};
                    position: relative;
                    ${
											scrollDirection === ScrollDirection.Horizontal
												? "transform: rotateX(180deg);"
												: ""
										}
                    width: fit-content;
                }

                .captuer-spin {
                    position: absolute;
                    left: 0px;
                    top: 0px;
                }

                .captuer-edge-mask {
                    display: flex;
                    flex-direction: ${
											scrollDirection === ScrollDirection.Horizontal
												? "row"
												: "column"
										};
                    position: absolute;
                    width: 100%;
                    height: 100%;
                }

                .captuer-edge-mask-top {
                    display: block;
                    background: rgba(0, 0, 0, 0.32);
                    width: 100%;
                }

                .captuer-edge-mask-bottom {
                    display: block;
                    background: rgba(0, 0, 0, 0.32);
                    width: 100%;
                }

                .touch-area-tip-container {
                    width: 100%;
                    height: 100%;
                    position: absolute;
                    left: 0px;
                    top: 0px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                }

                .touch-area-tip-container .touch-area-tip {
                    color: ${token.colorWhite};
                    text-align: center;
                    background-color: ${token.colorBgMask};
                    padding: ${token.paddingXXS}px ${token.paddingSM}px;
                    border-radius: ${token.borderRadiusSM}px;
                    box-shadow: 0 0 1px 0px ${token.colorPrimaryHover};
                    transition: box-shadow ${token.motionDurationFast} ${token.motionEaseInOut};
                }

                .touch-area-tip-container:hover .touch-area-tip {
                    box-shadow: 0 0 6px 0px ${token.colorPrimaryHover};
                }
            `}</style>
		</>
	);
};
