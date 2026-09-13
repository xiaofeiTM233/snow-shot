import { CloseOutlined, LockOutlined } from "@ant-design/icons";
import * as tauriOs from "@tauri-apps/plugin-os";
import { type ButtonProps, Flex, theme } from "antd";
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
import { closeFullScreenDrawWindow } from "@/commands/core";
import {
	DrawStatePublisher,
	type ExcalidrawEventParams,
	ExcalidrawEventPublisher,
} from "@/components/drawCore/extra";
import {
	ArrowIcon,
	ArrowSelectIcon,
	CircleIcon,
	DiamondIcon,
	EraserIcon,
	LaserPointerIcon,
	LineIcon,
	MouseThroughIcon,
	PenIcon,
	RectIcon,
	ResetCanvasIcon,
	SerialNumberIcon,
	TextIcon,
} from "@/components/icons";
import { AppSettingsActionContext } from "@/contexts/appSettingsActionContext";
import { fullScreenDrawChangeMouseThrough } from "@/functions/fullScreenDraw";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { useStateRef } from "@/hooks/useStateRef";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { findToolGroupHead, useToolbarLayout } from "@/hooks/useToolbarLayout";
import { HistoryControls } from "@/pages/draw/components/drawToolbar/components/historyControls";
import { ToolButton } from "@/pages/draw/components/drawToolbar/components/toolButton";
import { ToolbarGroupSlot } from "@/pages/draw/components/drawToolbar/components/toolbarGroupSlot";
import { buildToolbarContent } from "@/pages/draw/components/drawToolbar/toolbarContent";
import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import { DrawToolbarKeyEventKey } from "@/types/components/drawToolbar";
import { DrawState } from "@/types/draw";
import { ToolbarId, ToolbarToolKey } from "@/types/toolbarTool";
import { zIndexs } from "@/utils/zIndex";
import { useDrawContext } from "../../extra";

export type DrawToolbarActionType = {
	setTool: (drawState: DrawState) => void;
};

export const FullScreenDrawToolbar: React.FC<{
	actionRef: React.RefObject<DrawToolbarActionType | undefined>;
}> = ({ actionRef }) => {
	const intl = useIntl();
	const { token } = theme.useToken();

	const { updateAppSettings } = useContext(AppSettingsActionContext);
	const { getDrawCoreAction } = useDrawContext();
	const [getDrawState, _setDrawState] = useStateSubscriber(
		DrawStatePublisher,
		undefined,
	);
	const setDrawState = useCallback(
		(drawState: DrawState) => {
			_setDrawState(drawState);
		},
		[_setDrawState],
	);

	const [showLockDrawTool, setShowLockDrawTool, showLockDrawToolRef] =
		useStateRef(false);
	const [enableLockDrawTool, setEnableLockDrawTool, enableLockDrawToolRef] =
		useStateRef(false);
	const [mouseThroughHotkey, setMouseThroughHotkey] = useState("");

	const { orderedKeys, hiddenSet, groupsMap } = useToolbarLayout(
		ToolbarId.FullScreen,
	);
	const [toolbarLastUsedTool, setToolbarLastUsedTool, toolbarLastUsedToolRef] =
		useStateRef<Partial<Record<ToolbarToolKey, ToolbarToolKey>>>({});

	/** 工具运行时可见性 */
	const isToolRuntimeVisible = useCallback(
		(key: ToolbarToolKey) => {
			switch (key) {
				case ToolbarToolKey.LockTool:
					return showLockDrawToolRef.current;
				default:
					return true;
			}
		},
		[showLockDrawToolRef],
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
							type: "laser",
							locked: true,
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
			setDrawState,
			showLockDrawToolRef,
			updateAppSettings,
		],
	);

	const appSettingsDefaultToolRef = useRef<DrawState | undefined>(undefined);
	const excalidrawReadyRef = useRef(false);
	const appSettingsReadyRef = useRef(false);
	const initDefaultToolReadyRef = useRef(false);
	const initDefaultTool = useCallback((): void => {
		if (!appSettingsDefaultToolRef.current || !excalidrawReadyRef.current) {
			return;
		}

		onToolClick(appSettingsDefaultToolRef.current);
		setTimeout(() => {
			initDefaultToolReadyRef.current = true;
		}, 100);
	}, [onToolClick]);

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

				setMouseThroughHotkey(
					settings[AppSettingsGroup.AppFunction].fullScreenDraw.shortcutKey,
				);

				appSettingsDefaultToolRef.current =
					settings[AppSettingsGroup.FunctionFullScreenDraw].defaultTool;

				appSettingsReadyRef.current = true;
				initDefaultTool();
			},
			[
				setEnableLockDrawTool,
				setShowLockDrawTool,
				setToolbarLastUsedTool,
				initDefaultTool,
			],
		),
	);

	useStateSubscriber(
		ExcalidrawEventPublisher,
		useCallback(
			(params: ExcalidrawEventParams | undefined) => {
				if (initDefaultToolReadyRef.current) {
					if (params?.event === "onChange") {
						if (
							params.params.appState.activeTool.type === "selection" &&
							getDrawState() !== DrawState.Select &&
							getDrawState() !== DrawState.Idle
						) {
							onToolClick(DrawState.Select);
						}
					}
				}

				if (params?.event === "onDraw") {
					excalidrawReadyRef.current = true;
					initDefaultTool();
				}
			},
			[getDrawState, initDefaultTool, onToolClick],
		),
	);

	useImperativeHandle(
		actionRef,
		useCallback(() => {
			return {
				setTool: onToolClick,
			};
		}, [onToolClick]),
	);

	const toolButtonProps = useMemo<ButtonProps>(() => {
		return {
			size: "large",
		};
	}, []);

	const mouseThroughButtonTitle = useMemo(() => {
		if (!mouseThroughHotkey) {
			return intl.formatMessage({ id: "draw.mouseThroughTool" });
		}

		return intl.formatMessage(
			{
				id: "draw.keyEventTooltip",
			},
			{
				message: intl.formatMessage({ id: "draw.mouseThroughTool" }),
				key: mouseThroughHotkey,
			},
		);
	}, [intl, mouseThroughHotkey]);

	const [currentPlatform, setCurrentPlatform] = useState<tauriOs.Platform>();
	useEffect(() => {
		setCurrentPlatform(tauriOs.platform());
	}, []);

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
				case ToolbarToolKey.LaserPointerTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.LaserPointerTool}
							icon={
								<LaserPointerIcon
									style={{
										fontSize: "1.1em",
									}}
								/>
							}
							buttonProps={toolButtonProps}
							drawState={DrawState.LaserPointer}
							onClick={() => {
								onToolClick(DrawState.LaserPointer);
							}}
						/>
					);
				case ToolbarToolKey.ResetCanvasTool:
					return (
						<ToolButton
							icon={
								<ResetCanvasIcon
									style={{
										fontSize: "1.08em",
									}}
								/>
							}
							drawState={DrawState.ResetCanvas}
							buttonProps={{
								...toolButtonProps,
								title: intl.formatMessage({ id: "draw.resetCanvasTool" }),
							}}
							onClick={() => {
								getDrawCoreAction()?.updateScene({
									elements: [],
									captureUpdate: "IMMEDIATELY",
								});
							}}
						/>
					);
				case ToolbarToolKey.MouseThroughTool:
					return (
						<ToolButton
							icon={
								<MouseThroughIcon
									style={{
										fontSize: "0.95em",
									}}
								/>
							}
							drawState={DrawState.MouseThrough}
							buttonProps={{
								...toolButtonProps,
								title: mouseThroughButtonTitle,
							}}
							onClick={() => {
								fullScreenDrawChangeMouseThrough();
							}}
						/>
					);
				case ToolbarToolKey.CancelTool:
					return (
						<ToolButton
							componentKey={DrawToolbarKeyEventKey.CancelTool}
							icon={
								<CloseOutlined
									style={{
										fontSize: "0.9em",
										color: token.colorError,
									}}
								/>
							}
							buttonProps={toolButtonProps}
							drawState={DrawState.Cancel}
							onClick={() => {
								closeFullScreenDrawWindow();
							}}
						/>
					);
				default:
					return null;
			}
		},
		[
			enableLockDrawTool,
			getDrawCoreAction,
			intl,
			mouseThroughButtonTitle,
			onToolClick,
			showLockDrawTool,
			token.colorError,
			toolButtonProps,
		],
	);

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
		<div className="full-screen-draw-toolbar-container">
			<div className="full-screen-draw-toolbar">
				<Flex align="center" gap={token.paddingXS}>
					{buildToolbarContent(
						orderedKeys,
						hiddenSet,
						renderToolbarTool,
						token.paddingXS,
						groupsMap,
						renderGroup,
					)}

					{/* 撤销/重做仅用于注册快捷键，不显示 */}
					<HistoryControls hidden={true} disable={false} />
				</Flex>
			</div>

			<style jsx>{`
                .full-screen-draw-toolbar-container {
                    position: fixed;
                    top: 0;
                    left: 0;
                    pointer-events: none;
                    width: 100%;
                    display: flex;
                    justify-content: center;
                    z-index: ${zIndexs.FullScreenDraw_Toolbar};
                }

                .full-screen-draw-toolbar-container:hover {
                    z-index: ${zIndexs.FullScreenDraw_ToolbarHover};
                }

                .full-screen-draw-toolbar :global(.ant-btn) :global(.ant-btn-icon) {
                    font-size: 24px;
                    display: flex;
                    align-items: center;
                }

                :global(.full-screen-draw-toolbar > div) {
                    line-height: 0;
                }

                .full-screen-draw-toolbar {
                    pointer-events: auto;
                    /* macOS 下加上 menu bar 的高度 */
                    margin-top: ${token.marginLG + (currentPlatform === "macos" ? 24 : 0)}px;
                    z-index: ${zIndexs.FullScreenDraw_Toolbar};
                }

                .full-screen-draw-toolbar {
                    padding: ${token.paddingXXS}px ${token.paddingSM}px;
                    box-sizing: border-box;
                    background-color: ${token.colorBgContainer};
                    border-radius: ${token.borderRadiusLG}px;
                    cursor: default; /* 防止非拖动区域也变成可拖动状态 */
                    color: ${token.colorText};
                    box-shadow: 0 0 3px 0px ${token.colorPrimaryHover};
                    transition: opacity ${token.motionDurationMid} ${token.motionEaseInOut};
                }

                .full-screen-draw-toolbar :global(.draw-toolbar-splitter),
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
