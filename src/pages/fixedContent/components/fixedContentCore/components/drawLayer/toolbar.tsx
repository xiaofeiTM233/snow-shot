import { CheckOutlined, HolderOutlined, LockOutlined } from "@ant-design/icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button, type ButtonProps, Flex, theme } from "antd";
import {
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { useIntl } from "react-intl";
import { startFreeDrag } from "@/commands/core";
import {
	DrawCoreContext,
	DrawStatePublisher,
	type ExcalidrawEventParams,
	ExcalidrawEventPublisher,
} from "@/components/drawCore/extra";
import { EventListenerContext } from "@/components/eventListener";
import {
	ArrowIcon,
	ArrowSelectIcon,
	CircleIcon,
	CropIcon,
	DiamondIcon,
	DragWindowIcon,
	EraserIcon,
	FilterFreeDrawIcon,
	FilterIcon,
	HighlightIcon,
	LineIcon,
	PenIcon,
	RectIcon,
	SerialNumberIcon,
	TextIcon,
	WatermarkIcon,
} from "@/components/icons";
import { AppSettingsActionContext } from "@/contexts/appSettingsActionContext";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { useStateRef } from "@/hooks/useStateRef";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { findToolGroupHead, useToolbarLayout } from "@/hooks/useToolbarLayout";
import {
	type DragElementOptionalConfig,
	useDragElement,
} from "@/pages/draw/components/drawToolbar/components/dragButton";
import { HistoryControls } from "@/pages/draw/components/drawToolbar/components/historyControls";
import { ToolButton } from "@/pages/draw/components/drawToolbar/components/toolButton";
import { ToolbarGroupSlot } from "@/pages/draw/components/drawToolbar/components/toolbarGroupSlot";
import { BlurTool } from "@/pages/draw/components/drawToolbar/components/tools/blurTool";
import { HighlightTool } from "@/pages/draw/components/drawToolbar/components/tools/highlightTool";
import { getButtonTypeByState } from "@/pages/draw/components/drawToolbar/extra";
import { buildToolbarContent } from "@/pages/draw/components/drawToolbar/toolbarContent";
import type { DrawToolbarActionType } from "@/pages/fullScreenDraw/components/toolbar";
import { useDrawContext } from "@/pages/fullScreenDraw/extra";
import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import { DrawToolbarKeyEventKey } from "@/types/components/drawToolbar";
import { DrawState } from "@/types/draw";
import { ToolbarId, ToolbarToolKey } from "@/types/toolbarTool";
import { formatKey } from "@/utils/format";
import { zIndexs } from "@/utils/zIndex";
import type { FixedContentWindowSize } from "../..";

export type FixedContentCoreDrawToolbarActionType = {
	getSize: () => { width: number; height: number };
} & DrawToolbarActionType;

export const BOX_SHADOW_WIDTH = 3;

export const FixedContentCoreDrawToolbar: React.FC<{
	actionRef: React.RefObject<FixedContentCoreDrawToolbarActionType | undefined>;
	documentSize: FixedContentWindowSize;
	disabled?: boolean;
	onConfirm: () => void;
	switchDraw: () => void;
	onCrop?: () => void;
}> = ({ actionRef, documentSize, disabled, onConfirm, switchDraw, onCrop }) => {
	const { token } = theme.useToken();
	const intl = useIntl();

	const { updateAppSettings } = useContext(AppSettingsActionContext);
	const { getDrawCoreAction } = useDrawContext();
	const [getDrawState, setDrawState] = useStateSubscriber(
		DrawStatePublisher,
		undefined,
	);

	const [showLockDrawTool, setShowLockDrawTool, showLockDrawToolRef] =
		useStateRef(false);
	const [enableLockDrawTool, setEnableLockDrawTool, enableLockDrawToolRef] =
		useStateRef(false);
	const [switchDrawHotKey, setSwitchDrawHotKey] = useState("");

	const { orderedKeys, hiddenSet, groupsMap } = useToolbarLayout(
		ToolbarId.FixedContent,
	);
	const [toolbarLastUsedTool, setToolbarLastUsedTool, toolbarLastUsedToolRef] =
		useStateRef<Partial<Record<ToolbarToolKey, ToolbarToolKey>>>({});

	/** 工具运行时可见性 */
	const isToolRuntimeVisible = useCallback(
		(key: ToolbarToolKey) => {
			switch (key) {
				case ToolbarToolKey.LockTool:
					return showLockDrawToolRef.current;
				case ToolbarToolKey.CropTool:
					return !!onCrop;
				default:
					return true;
			}
		},
		[onCrop, showLockDrawToolRef],
	);

	/** 记录组合最后使用的成员 */
	const updateGroupLastUsed = useCallback(
		(memberKey: ToolbarToolKey) => {
			const headKey = findToolGroupHead(memberKey, groupsMap);
			if (!headKey) {
				return;
			}

			updateAppSettings(
				AppSettingsGroup.Cache,
				{
					toolbarLastUsedTool: {
						...toolbarLastUsedToolRef.current,
						[headKey]: memberKey,
					},
				},
				true,
				true,
				false,
				true,
				false,
			);
		},
		[groupsMap, toolbarLastUsedToolRef, updateAppSettings],
	);

	const {
		getLimitRect,
		getDevicePixelRatio,
		getContentScale,
		calculatedBoundaryRect,
	} = useContext(DrawCoreContext);

	const getSelectedRect = useCallback(() => {
		return (
			getLimitRect() ?? {
				min_x: 0,
				min_y: 0,
				max_x: 0,
				max_y: 0,
			}
		);
	}, [getLimitRect]);
	const toolbarElementRef = useRef<HTMLDivElement>(null);

	const getSize = useCallback(() => {
		return {
			width:
				(toolbarElementRef.current?.clientWidth ?? 0) + BOX_SHADOW_WIDTH * 2,
			height:
				(toolbarElementRef.current?.clientHeight ?? 0) +
				BOX_SHADOW_WIDTH * 2 +
				token.marginXXS,
		};
	}, [token.marginXXS]);

	const {
		update: updateDrawToolbarStyleCore,
		reset: resetDrag,
		onMouseDown,
		onMouseMove,
		onMouseUp,
	} = useDragElement(
		useMemo(() => {
			return {
				getBaseOffset: (element) => {
					const limitRect = getSelectedRect();
					const devicePixelRatio = getDevicePixelRatio();
					return {
						x:
							limitRect.max_x / devicePixelRatio -
							BOX_SHADOW_WIDTH -
							element.clientWidth,
						y: limitRect.max_y / devicePixelRatio + token.marginXXS,
					};
				},
			};
		}, [getDevicePixelRatio, getSelectedRect, token.marginXXS]),
		// 溢出回退：底部溢出时翻转到贴图框上方，上方也溢出则回退到右下角默认位置
		useMemo<DragElementOptionalConfig[]>(() => {
			return [
				{
					config: {
						getBaseOffset: (element) => {
							const limitRect = getSelectedRect();
							const devicePixelRatio = getDevicePixelRatio();
							return {
								x:
									limitRect.max_x / devicePixelRatio -
									BOX_SHADOW_WIDTH -
									element.clientWidth,
								y:
									limitRect.min_y / devicePixelRatio -
									element.clientHeight -
									token.marginXXS,
							};
						},
					},
					needTry: (dragRes) => dragRes.isBeyondMaxY,
					canApply: (dragRes) =>
						!(dragRes.isBeyondMaxY || dragRes.isBeyondMinY),
				},
			];
		}, [getDevicePixelRatio, getSelectedRect, token.marginXXS]),
	);

	const updateDrawToolbarStyle = useCallback(() => {
		const element = toolbarElementRef.current;
		if (!element) {
			return;
		}

		updateDrawToolbarStyleCore(
			element,
			getContentScale?.(),
			calculatedBoundaryRect,
		);
	}, [updateDrawToolbarStyleCore, getContentScale, calculatedBoundaryRect]);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			e.stopPropagation();
			onMouseDown(e);
		},
		[onMouseDown],
	);

	useEffect(() => {
		if (disabled) {
			return;
		}

		const handleMouseMove = (event: MouseEvent) => {
			if (!toolbarElementRef.current) {
				return;
			}

			onMouseMove(
				event,
				toolbarElementRef.current,
				getContentScale?.(),
				calculatedBoundaryRect,
			);
		};
		const handleMouseUp = () => {
			onMouseUp();
		};

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [
		calculatedBoundaryRect,
		disabled,
		getContentScale,
		onMouseMove,
		onMouseUp,
	]);

	const onToolClick = useCallback(
		(drawState: DrawState) => {
			const drawCoreAction = getDrawCoreAction();

			const prev = getDrawState();

			if (drawState === DrawState.Lock) {
				updateAppSettings(
					AppSettingsGroup.Cache,
					{ enableLockDrawTool: !enableLockDrawToolRef.current },
					true,
					true,
					false,
					true,
					false,
				);

				return;
			}

			if (drawState === DrawState.Confirm) {
				onConfirm();
				return;
			}

			let next = drawState;

			if (prev === drawState && prev !== DrawState.Idle) {
				if (drawState === DrawState.ScrollScreenshot) {
					next = DrawState.Idle;
				} else {
					next = DrawState.Select;
				}
			}

			let toolLocked = true;
			if (showLockDrawToolRef.current) {
				toolLocked = enableLockDrawToolRef.current;
			}

			switch (next) {
				case DrawState.Select:
					drawCoreAction?.setActiveTool(
						{
							type: "selection",
						},
						undefined,
						next,
					);
					break;
				case DrawState.Rect:
					drawCoreAction?.setActiveTool(
						{
							type: "rectangle",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.Diamond:
					drawCoreAction?.setActiveTool(
						{
							type: "diamond",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.Ellipse:
					drawCoreAction?.setActiveTool(
						{
							type: "ellipse",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.Arrow:
					drawCoreAction?.setActiveTool(
						{
							type: "arrow",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.Line:
					drawCoreAction?.setActiveTool(
						{
							type: "line",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.Pen:
					drawCoreAction?.setActiveTool(
						{
							type: "freedraw",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.Text:
					drawCoreAction?.setActiveTool(
						{
							type: "text",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.SerialNumber:
					break;
				case DrawState.Blur:
					drawCoreAction?.setActiveTool(
						{
							type: "blur",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.BlurFreeDraw:
					drawCoreAction?.setActiveTool(
						{
							type: "blur_freedraw",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.Watermark:
					drawCoreAction?.setActiveTool(
						{
							type: "watermark",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.Highlight:
					drawCoreAction?.setActiveTool(
						{
							type: "highlight",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.Eraser:
					drawCoreAction?.setActiveTool(
						{
							type: "eraser",
							locked: toolLocked,
						},
						undefined,
						next,
					);
					break;
				case DrawState.LaserPointer:
					drawCoreAction?.setActiveTool(
						{
							type: "laser",
							locked: true,
						},
						undefined,
						next,
					);
					break;
				case DrawState.MouseThrough:
					drawCoreAction?.setActiveTool(
						{
							type: "selection",
						},
						undefined,
						next,
					);
					break;
				default:
					break;
			}

			setDrawState(next);
		},
		[
			enableLockDrawToolRef,
			getDrawCoreAction,
			getDrawState,
			onConfirm,
			setDrawState,
			showLockDrawToolRef,
			updateAppSettings,
		],
	);

	useAppSettingsLoad(
		useCallback(
			(settings: AppSettingsData) => {
				// 不显示锁定绘制工具
				setShowLockDrawTool(
					!settings[AppSettingsGroup.FunctionDraw].lockDrawTool,
				);
				// 是否启用锁定绘制工具
				setEnableLockDrawTool(
					settings[AppSettingsGroup.Cache].enableLockDrawTool,
				);
				// 工具栏组合最后使用的成员
				setToolbarLastUsedTool(
					settings[AppSettingsGroup.Cache].toolbarLastUsedTool,
				);
				setSwitchDrawHotKey(
					settings[AppSettingsGroup.CommonKeyEvent].fixedContentEnableDraw
						.hotKey,
				);
			},
			[setEnableLockDrawTool, setShowLockDrawTool, setToolbarLastUsedTool],
		),
	);

	useStateSubscriber(
		ExcalidrawEventPublisher,
		useCallback(
			(params: ExcalidrawEventParams | undefined) => {
				if (params?.event === "onChange") {
					if (
						params.params.appState.activeTool.type === "selection" &&
						getDrawState() !== DrawState.Select &&
						getDrawState() !== DrawState.Idle
					) {
						onToolClick(DrawState.Select);
					}
				}
			},
			[getDrawState, onToolClick],
		),
	);

	useImperativeHandle(
		actionRef,
		useCallback(() => {
			return {
				setTool: onToolClick,
				getSize,
			};
		}, [getSize, onToolClick]),
	);

	useEffect(() => {
		if (disabled) {
			if (toolbarElementRef.current) {
				toolbarElementRef.current.style.opacity = "0";
			}
		} else {
			setTimeout(() => {
				resetDrag();
				updateDrawToolbarStyle();

				if (toolbarElementRef.current) {
					toolbarElementRef.current.style.opacity = "1";
				}
			}, 17);
		}
	}, [disabled, resetDrag, updateDrawToolbarStyle]);

	const toolButtonProps = useMemo<ButtonProps>(() => {
		return {};
	}, []);

	const confirmButtonTitle = useMemo(() => {
		return intl.formatMessage(
			{
				id: "draw.keyEventTooltip",
			},
			{
				message: intl.formatMessage({
					id: "draw.confirm",
				}),
				key: formatKey(switchDrawHotKey),
			},
		);
	}, [intl, switchDrawHotKey]);

	const dragTitle = useMemo(() => {
		return intl.formatMessage({ id: "draw.drag" });
	}, [intl]);

	const dragWindowButtonTitle = useMemo(() => {
		return intl.formatMessage({ id: "draw.dragWindow" });
	}, [intl]);

	const renderToolbarTool = useCallback(
		(key: ToolbarToolKey): React.ReactNode => {
			switch (key) {
				case ToolbarToolKey.SelectTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.SelectTool}
							icon={<ArrowSelectIcon style={{ fontSize: "1.2em" }} />}
							drawState={DrawState.Select}
							buttonProps={toolButtonProps}
							onClick={() => {
								onToolClick(DrawState.Select);
							}}
						/>
					);
				case ToolbarToolKey.LockTool:
					if (!showLockDrawTool) {
						return null;
					}
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.LockDrawTool}
							icon={<LockOutlined />}
							drawState={DrawState.Lock}
							enableState={enableLockDrawTool}
							onClick={() => {
								onToolClick(DrawState.Lock);
							}}
						/>
					);
				case ToolbarToolKey.CropTool:
					if (!onCrop) {
						return null;
					}
					return (
						<Button
							{...toolButtonProps}
							icon={
								<CropIcon
									style={{
										fontSize: "1.1em",
									}}
								/>
							}
							type={getButtonTypeByState(false)}
							title={intl.formatMessage({ id: "draw.crop" })}
							onClick={() => {
								onCrop();
							}}
						/>
					);
				case ToolbarToolKey.RectTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.RectTool}
							icon={<RectIcon style={{ fontSize: "1em" }} />}
							drawState={DrawState.Rect}
							buttonProps={toolButtonProps}
							onClick={() => {
								onToolClick(DrawState.Rect);
							}}
						/>
					);
				case ToolbarToolKey.DiamondTool:
					return (
						<ToolButton
							icon={<DiamondIcon />}
							drawState={DrawState.Diamond}
							buttonProps={{
								...toolButtonProps,
								title: intl.formatMessage({ id: "draw.diamondTool" }),
							}}
							onClick={() => {
								onToolClick(DrawState.Diamond);
							}}
						/>
					);
				case ToolbarToolKey.EllipseTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.EllipseTool}
							icon={
								<CircleIcon
									style={{
										fontSize: "1em",
									}}
								/>
							}
							buttonProps={toolButtonProps}
							drawState={DrawState.Ellipse}
							onClick={() => {
								onToolClick(DrawState.Ellipse);
							}}
						/>
					);
				case ToolbarToolKey.ArrowTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.ArrowTool}
							icon={<ArrowIcon style={{ fontSize: "0.83em" }} />}
							drawState={DrawState.Arrow}
							buttonProps={toolButtonProps}
							onClick={() => {
								onToolClick(DrawState.Arrow);
							}}
						/>
					);
				case ToolbarToolKey.LineTool:
					return (
						<ToolButton
							icon={<LineIcon style={{ fontSize: "1.15em", height: "1em" }} />}
							drawState={DrawState.Line}
							buttonProps={{
								...toolButtonProps,
								title: intl.formatMessage({ id: "draw.lineTool" }),
							}}
							onClick={() => {
								onToolClick(DrawState.Line);
							}}
						/>
					);
				case ToolbarToolKey.PenTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.PenTool}
							icon={<PenIcon style={{ fontSize: "1.15em" }} />}
							buttonProps={toolButtonProps}
							drawState={DrawState.Pen}
							onClick={() => {
								onToolClick(DrawState.Pen);
							}}
						/>
					);
				case ToolbarToolKey.TextTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.TextTool}
							icon={<TextIcon style={{ fontSize: "1.15em" }} />}
							drawState={DrawState.Text}
							buttonProps={toolButtonProps}
							onClick={() => {
								onToolClick(DrawState.Text);
							}}
						/>
					);
				case ToolbarToolKey.SerialNumberTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.SerialNumberTool}
							icon={
								<SerialNumberIcon
									style={{
										fontSize: "1.16em",
									}}
								/>
							}
							drawState={DrawState.SerialNumber}
							buttonProps={toolButtonProps}
							onClick={() => {
								onToolClick(DrawState.SerialNumber);
							}}
						/>
					);
				case ToolbarToolKey.BlurTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.BlurTool}
							icon={<FilterIcon />}
							drawState={DrawState.Blur}
							buttonProps={toolButtonProps}
							onClick={() => {
								onToolClick(DrawState.Blur);
							}}
						/>
					);
				case ToolbarToolKey.BlurFreeDrawTool:
					return (
						<ToolButton
							icon={<FilterFreeDrawIcon style={{ fontSize: "1em" }} />}
							drawState={DrawState.BlurFreeDraw}
							buttonProps={{
								...toolButtonProps,
								title: intl.formatMessage({ id: "draw.blurFreeDrawTool" }),
							}}
							onClick={() => {
								onToolClick(DrawState.BlurFreeDraw);
							}}
						/>
					);
				case ToolbarToolKey.EraserTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.EraserTool}
							icon={
								<EraserIcon
									style={{
										fontSize: "0.95em",
									}}
								/>
							}
							drawState={DrawState.Eraser}
							buttonProps={toolButtonProps}
							onClick={() => {
								onToolClick(DrawState.Eraser);
							}}
						/>
					);
				case ToolbarToolKey.WatermarkTool:
					return (
						<ToolButton
							icon={<WatermarkIcon />}
							drawState={DrawState.Watermark}
							buttonProps={{
								...toolButtonProps,
								title: intl.formatMessage({ id: "draw.watermarkTool" }),
							}}
							onClick={() => {
								onToolClick(DrawState.Watermark);
							}}
						/>
					);
				case ToolbarToolKey.HighlightTool:
					return (
						<ToolButton
							icon={<HighlightIcon />}
							drawState={DrawState.Highlight}
							buttonProps={{
								...toolButtonProps,
								title: intl.formatMessage({ id: "draw.highlightTool" }),
							}}
							onClick={() => {
								onToolClick(DrawState.Highlight);
							}}
						/>
					);
				case ToolbarToolKey.HistoryTool:
					return <HistoryControls disable={disabled ?? false} />;
				case ToolbarToolKey.ConfirmTool:
					return (
						<Button
							{...toolButtonProps}
							icon={
								<CheckOutlined
									style={{
										color: token.colorPrimary,
									}}
								/>
							}
							type={getButtonTypeByState(false)}
							title={confirmButtonTitle}
							onClick={() => {
								onToolClick(DrawState.Confirm);
							}}
						/>
					);
				default:
					return null;
			}
		},
		[
			confirmButtonTitle,
			disabled,
			enableLockDrawTool,
			intl,
			onCrop,
			onToolClick,
			showLockDrawTool,
			token.colorPrimary,
			toolButtonProps,
		],
	);

	const { addListener, removeListener } = useContext(EventListenerContext);

	const isDragToolRef = useRef(false);
	const startFreeDragAction = useCallback(() => {
		isDragToolRef.current = true;
		switchDraw();
		startFreeDrag();
	}, [switchDraw]);

	useEffect(() => {
		const windowLabel = getCurrentWindow().label;
		const listenerId = addListener("free-drag-window-service:stop", (args) => {
			const payload = (
				args as {
					payload: {
						size: { width: number; height: number };
						label: string;
					};
				}
			).payload;

			if (payload.label !== windowLabel) {
				return;
			}

			if (isDragToolRef.current) {
				switchDraw();
			}
			isDragToolRef.current = false;
		});

		return () => {
			removeListener(listenerId);
		};
	}, [addListener, removeListener, switchDraw]);

	const renderGroup = useCallback(
		(headKey: ToolbarToolKey, members: ToolbarToolKey[]) => (
			<ToolbarGroupSlot
				headKey={headKey}
				members={members}
				hiddenSet={hiddenSet}
				isToolVisible={isToolRuntimeVisible}
				lastUsedKey={toolbarLastUsedTool[headKey]}
				onMemberClick={updateGroupLastUsed}
				renderTool={renderToolbarTool}
			/>
		),
		[
			hiddenSet,
			isToolRuntimeVisible,
			renderToolbarTool,
			toolbarLastUsedTool,
			updateGroupLastUsed,
		],
	);

	return (
		<div className="fixed-content-draw-toolbar-container">
			<div className="fixed-content-draw-toolbar" ref={toolbarElementRef}>
				<Flex align="center" gap={token.paddingXS}>
					<div
						className="drag-button"
						title={dragTitle}
						onMouseDown={handleMouseDown}
					>
						<HolderOutlined />
					</div>

					{/* 拖动窗口按钮是窗口锚点，固定在头部，不参与排序与显隐 */}
					<Button
						{...toolButtonProps}
						icon={
							<DragWindowIcon
								style={{
									fontSize: "1.15em",
								}}
							/>
						}
						type={getButtonTypeByState(false)}
						title={dragWindowButtonTitle}
						onMouseDown={startFreeDragAction}
					/>

					{buildToolbarContent(
						orderedKeys,
						hiddenSet,
						renderToolbarTool,
						token.paddingXS,
						groupsMap,
						renderGroup,
					)}
				</Flex>

				<BlurTool />
				<HighlightTool />
			</div>

			<style jsx>{`
                .fixed-content-draw-toolbar-container {
                    position: fixed;
                    width: ${documentSize.width - BOX_SHADOW_WIDTH * 2}px;
                    pointer-events: none;
                    z-index: ${zIndexs.FullScreenDraw_Toolbar};
                    display: flex;
                    left: 0;
                    top: 0;
                }

                .fixed-content-draw-toolbar-container:hover {
                    z-index: ${zIndexs.FullScreenDraw_ToolbarHover};
                }

                .fixed-content-draw-toolbar {
                    opacity: 0;
                    transition: opacity ${token.motionDurationFast} ${token.motionEaseInOut};
                }

                .fixed-content-draw-toolbar :global(.ant-btn) :global(.ant-btn-icon) {
                    font-size: 24px;
                    display: flex;
                    align-items: center;
                }

                .fixed-content-draw-toolbar .drag-button {
                    color: ${token.colorTextQuaternary};
                    cursor: move;
                    font-size: 18px;
                }

                .fixed-content-draw-toolbar {
                    pointer-events: ${disabled ? "none" : "auto"};
                }

                :global(.fixed-content-draw-toolbar > div) {
                    line-height: 0;
                }

                .fixed-content-draw-toolbar {
                    padding: ${token.paddingXXS}px ${token.paddingSM}px;
                    box-sizing: border-box;
                    background-color: ${token.colorBgContainer};
                    border-radius: ${token.borderRadiusLG}px;
                    cursor: default; /* 防止非拖动区域也变成可拖动状态 */
                    color: ${token.colorText};
                    box-shadow: 0 0 3px 0px ${token.colorPrimaryHover};
                    transition: opacity ${token.motionDurationMid} ${token.motionEaseInOut};
                }

                .fixed-content-draw-toolbar :global(.draw-toolbar-splitter),
                .draw-toolbar-splitter {
                    width: 1px;
                    height: 1.6em;
                    background-color: ${token.colorBorder};
                    margin: 0 ${token.marginXS}px;
                }
            `}</style>
		</div>
	);
};
