import {
	CloseOutlined,
	EnterOutlined,
	EyeInvisibleOutlined,
	EyeOutlined,
	LineOutlined,
	RestOutlined,
} from "@ant-design/icons";
import {
	type Collision,
	type CollisionDetection,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	PointerSensor,
	pointerWithin,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
} from "@dnd-kit/sortable";
import { Button, Tabs, Tooltip, theme } from "antd";
import type React from "react";
import {
	Fragment,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
	PLUGIN_ID_FFMPEG,
	PLUGIN_ID_RAPID_OCR,
	PLUGIN_ID_TRANSLATE,
} from "@/constants/pluginService";
import {
	isToolbarToolKey,
	TOOLBAR_TOOL_DEFINITIONS,
} from "@/constants/toolbarTools";
import { AppSettingsActionContext } from "@/contexts/appSettingsActionContext";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { useToolbarLayout } from "@/hooks/useToolbarLayout";
import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import {
	TOOLBAR_ITEM_LINE_BREAK,
	TOOLBAR_ITEM_SEPARATOR,
	type ToolbarGroupsMap,
	ToolbarId,
	type ToolbarItem,
	ToolbarToolKey,
} from "@/types/toolbarTool";

const HIDDEN_CONTAINER_ID = "toolbar-editor-hidden";
const ROW_CONTAINER_ID = "toolbar-editor-row";
const PANEL_CONTAINER_PREFIX = "toolbar-editor-panel:";
const PALETTE_SEPARATOR_ID = "palette:separator";
const PALETTE_LINE_BREAK_ID = "palette:lineBreak";
const TOOL_CHIP_PREFIX = "tool:";
const TOKEN_CHIP_PREFIX = "token:";

type EditorTokenKind =
	| typeof TOOLBAR_ITEM_SEPARATOR
	| typeof TOOLBAR_ITEM_LINE_BREAK;

type EditorSlot =
	| { kind: "tool"; key: ToolbarToolKey; members: ToolbarToolKey[] }
	| { kind: "token"; token: EditorTokenKind; uid: string };

type EditorState = {
	slots: EditorSlot[];
	hiddenKeys: ToolbarToolKey[];
};

type DragId = string;

/** 所有芯片统一使用稳定 id，跨容器移动时 id 保持稳定，拖拽不中断 */
const toolChipId = (key: ToolbarToolKey): DragId => `${TOOL_CHIP_PREFIX}${key}`;
const tokenChipId = (uid: string): DragId => `${TOKEN_CHIP_PREFIX}${uid}`;
const panelContainerId = (head: ToolbarToolKey): DragId =>
	`${PANEL_CONTAINER_PREFIX}${head}`;

const slotIdOf = (slot: EditorSlot): DragId =>
	slot.kind === "tool" ? toolChipId(slot.key) : tokenChipId(slot.uid);

type ParsedDragId =
	| { kind: "tool"; key: ToolbarToolKey }
	| { kind: "token"; uid: string }
	| { kind: "panel"; head: ToolbarToolKey }
	| { kind: "palette"; token: EditorTokenKind }
	| { kind: "container"; name: "hidden" }
	| { kind: "row" }
	| { kind: "unknown" };

const parseDragId = (id: string): ParsedDragId => {
	if (id === HIDDEN_CONTAINER_ID) {
		return { kind: "container", name: "hidden" };
	}
	if (id === ROW_CONTAINER_ID) {
		return { kind: "row" };
	}
	if (id === PALETTE_SEPARATOR_ID) {
		return { kind: "palette", token: TOOLBAR_ITEM_SEPARATOR };
	}
	if (id === PALETTE_LINE_BREAK_ID) {
		return { kind: "palette", token: TOOLBAR_ITEM_LINE_BREAK };
	}
	if (id.startsWith(PANEL_CONTAINER_PREFIX)) {
		return {
			kind: "panel",
			head: id.slice(PANEL_CONTAINER_PREFIX.length) as ToolbarToolKey,
		};
	}
	if (id.startsWith(TOOL_CHIP_PREFIX)) {
		return { kind: "tool", key: id.slice(5) as ToolbarToolKey };
	}
	if (id.startsWith(TOKEN_CHIP_PREFIX)) {
		return { kind: "token", uid: id.slice(TOKEN_CHIP_PREFIX.length) };
	}
	return { kind: "unknown" };
};

const TOOLBAR_SETTINGS_FIELDS: Record<
	ToolbarId,
	{ orderKey: string; groupsKey: string; hiddenKey: string }
> = {
	[ToolbarId.Main]: {
		orderKey: "toolbarToolOrder",
		groupsKey: "toolbarGroups",
		hiddenKey: "toolbarHiddenTools",
	},
	[ToolbarId.FullScreen]: {
		orderKey: "fullScreenToolbarToolOrder",
		groupsKey: "fullScreenToolbarGroups",
		hiddenKey: "fullScreenToolbarHiddenTools",
	},
	[ToolbarId.FixedContent]: {
		orderKey: "fixedContentToolbarToolOrder",
		groupsKey: "fixedContentToolbarGroups",
		hiddenKey: "fixedContentToolbarHiddenTools",
	},
};

/** 编辑器内工具是否因插件未就绪而在画布上不显示（仍允许配置，仅置灰提示） */
const useToolPluginReady = () => {
	const { isReadyStatus } = usePluginServiceContext();

	return useCallback(
		(key: ToolbarToolKey): boolean => {
			switch (key) {
				case ToolbarToolKey.OcrDetectTool:
					return !!isReadyStatus?.(PLUGIN_ID_RAPID_OCR);
				case ToolbarToolKey.OcrTranslateTool:
				case ToolbarToolKey.OpenTranslationTool:
					return !!(
						isReadyStatus?.(PLUGIN_ID_RAPID_OCR) &&
						isReadyStatus?.(PLUGIN_ID_TRANSLATE)
					);
				case ToolbarToolKey.VideoRecordTool:
					return !!isReadyStatus?.(PLUGIN_ID_FFMPEG);
				default:
					return true;
			}
		},
		[isReadyStatus],
	);
};

/** 计算指针相对投放目标的合并判定与前后位置（指针落在目标中间 40% 区域视为合并） */
const resolveDropSide = (
	event: DragEndEvent | DragOverEvent,
): {
	merge: boolean;
	position: "before" | "after";
} => {
	const { activatorEvent, delta, over } = event;
	if (!over) {
		return { merge: false, position: "after" };
	}
	const rect = over.rect;
	if (!rect || rect.width === 0) {
		return { merge: false, position: "after" };
	}
	const clientX =
		activatorEvent instanceof MouseEvent
			? activatorEvent.clientX
			: (activatorEvent as PointerEvent).clientX;
	const pointerX = clientX + delta.x;
	const centerX = rect.left + rect.width / 2;
	const merge = Math.abs(pointerX - centerX) <= rect.width * 0.2;
	return { merge, position: pointerX < centerX ? "before" : "after" };
};

/**
 * 将编辑器槽位整理为合法序列（与 parseToolbarItemList 规则一致）：
 * 清理行首/行尾/相邻冗余 token，保证持久化后重新加载不丢元素。
 */
const normalizeEditorSlots = (slots: EditorSlot[]): EditorSlot[] => {
	const result: EditorSlot[] = [];
	for (const slot of slots) {
		if (slot.kind === "tool") {
			result.push(slot);
			continue;
		}
		const last = result[result.length - 1];
		if (slot.token === TOOLBAR_ITEM_LINE_BREAK) {
			if (result.length > 0 && last?.kind !== "token") {
				result.push(slot);
			}
			continue;
		}
		if (result.length > 0 && last?.kind === "tool") {
			result.push(slot);
		}
	}
	while (result.length > 0 && result[result.length - 1].kind === "token") {
		result.pop();
	}
	return result;
};

/** token 可见落点范围：必须夹在首个工具之后、末个工具之前，否则画布上不可见 */
const clampTokenIndex = (slots: EditorSlot[], index: number): number | null => {
	let first = -1;
	let last = -1;
	slots.forEach((slot, i) => {
		if (slot.kind === "tool") {
			if (first < 0) {
				first = i;
			}
			last = i;
		}
	});
	if (first < 0) {
		return null;
	}
	return Math.min(Math.max(index, first + 1), last);
};

/**
 * 自定义碰撞检测：在 pointerWithin 基础上按投放目标面积升序排序，
 * 保证嵌套时优先命中更小（更深层）的目标（芯片优先于其所在容器）。
 */
const nestedFirstCollisionDetection: CollisionDetection = (args) => {
	const collisions = pointerWithin(args);
	if (collisions.length <= 1) {
		return collisions;
	}
	const areaOf = (collision: Collision): number => {
		const rect = collision.data?.droppableContainer.rect?.current;
		if (!rect) {
			return Number.MAX_SAFE_INTEGER;
		}
		return rect.width * rect.height;
	};
	return [...collisions].sort((a, b) => areaOf(a) - areaOf(b));
};

/** 工具栏形态的图标按钮（与画布工具栏同款视觉），整颗按钮可拖拽 */
const ToolButtonChip: React.FC<{
	dragId: DragId;
	icon: React.ReactNode;
	title: string;
	dimmed?: boolean;
	/** 合并目标高亮：蓝色虚线环 */
	mergeTarget?: boolean;
	/** 悬停时显示的眼睛按钮动作 */
	eyeAction?: "hide" | "show";
	onEyeClick?: () => void;
}> = ({ dragId, icon, title, dimmed, mergeTarget, eyeAction, onEyeClick }) => {
	const { token } = theme.useToken();
	const { attributes, listeners, setNodeRef, isDragging } = useSortable({
		id: dragId,
	});

	return (
		<div
			{...attributes}
			{...listeners}
			ref={setNodeRef}
			style={{
				position: "relative",
				display: "inline-flex",
				opacity: isDragging ? 0.4 : dimmed ? 0.4 : 1,
				cursor: "grab",
				borderRadius: token.borderRadius,
				outline: mergeTarget
					? `2px dashed ${token.colorPrimary}`
					: "2px solid transparent",
			}}
		>
			<Button icon={icon} title={title} type="text" />
			{eyeAction && (
				<Tooltip
					title={
						<FormattedMessage
							id={
								eyeAction === "hide"
									? "settings.toolbarCustomizer.hide"
									: "settings.toolbarCustomizer.show"
							}
						/>
					}
				>
					<Button
						size="small"
						type="primary"
						shape="circle"
						style={{
							position: "absolute",
							top: -6,
							right: -6,
							width: 18,
							height: 18,
							minWidth: 18,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
						}}
						icon={
							eyeAction === "hide" ? (
								<EyeInvisibleOutlined style={{ fontSize: 11 }} />
							) : (
								<EyeOutlined style={{ fontSize: 11 }} />
							)
						}
						onPointerDown={(event) => {
							event.stopPropagation();
						}}
						onClick={(event) => {
							event.stopPropagation();
							onEyeClick?.();
						}}
					/>
				</Tooltip>
			)}
		</div>
	);
};

/** token 悬停时显示的删除小圆钮 */
const TokenDeleteButton: React.FC<{
	color: string;
	style?: React.CSSProperties;
	onClick: () => void;
}> = ({ color, style, onClick }) => {
	return (
		<Button
			size="small"
			shape="circle"
			className="toolbar-editor-mini-btn"
			icon={<CloseOutlined style={{ fontSize: 9 }} />}
			style={{
				position: "absolute",
				width: 16,
				height: 16,
				minWidth: 16,
				display: "none",
				alignItems: "center",
				justifyContent: "center",
				backgroundColor: color,
				color: "#fff",
				zIndex: 30,
				...style,
			}}
			onPointerDown={(event) => {
				event.stopPropagation();
			}}
			onClick={(event) => {
				event.stopPropagation();
				onClick();
			}}
		/>
	);
};

/** 元素面板中的可拖拽 token */
const PaletteChip: React.FC<{
	dragId: DragId;
	icon: React.ReactNode;
	label: string;
}> = ({ dragId, icon, label }) => {
	const { token } = theme.useToken();
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: dragId,
	});

	return (
		<div
			{...attributes}
			{...listeners}
			ref={setNodeRef}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "4px 10px",
				border: `0.5px solid ${token.colorBorderSecondary}`,
				borderRadius: token.borderRadius,
				backgroundColor: token.colorBgContainer,
				fontSize: token.fontSizeSM,
				cursor: "grab",
				userSelect: "none",
				opacity: isDragging ? 0.5 : 1,
			}}
		>
			{icon}
			<span>{label}</span>
		</div>
	);
};

/** 编辑器中的显式分隔符槽位 */
const SeparatorSlot: React.FC<{
	dragId: DragId;
	onDelete: () => void;
}> = ({ dragId, onDelete }) => {
	const { token } = theme.useToken();
	const { attributes, listeners, setNodeRef, isDragging } = useSortable({
		id: dragId,
	});

	return (
		<div
			{...attributes}
			{...listeners}
			ref={setNodeRef}
			className="toolbar-editor-token"
			style={{
				position: "relative",
				width: 10,
				height: 34,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				cursor: "grab",
				borderRadius: 4,
				opacity: isDragging ? 0.4 : 1,
			}}
		>
			<i
				style={{
					width: 2,
					height: 24,
					backgroundColor: token.colorBorder,
					borderRadius: 1,
				}}
			/>
			<TokenDeleteButton
				color={token.colorError}
				style={{ top: -6, right: -8 }}
				onClick={onDelete}
			/>
		</div>
	);
};

/** 编辑器中的显式换行槽位（强制断行，形成第二行） */
const LineBreakSlot: React.FC<{
	dragId: DragId;
	onDelete: () => void;
}> = ({ dragId, onDelete }) => {
	const { token } = theme.useToken();
	const { attributes, listeners, setNodeRef, isDragging } = useSortable({
		id: dragId,
	});

	return (
		<div
			{...attributes}
			{...listeners}
			ref={setNodeRef}
			className="toolbar-editor-token"
			style={{
				position: "relative",
				flexBasis: "100%",
				height: 0,
				borderTop: `1.5px dashed ${token.colorPrimaryBorder}`,
				cursor: "grab",
				opacity: isDragging ? 0.4 : 1,
			}}
		>
			<span
				style={{
					position: "absolute",
					left: 0,
					top: -19,
					display: "flex",
					alignItems: "center",
					gap: 2,
					fontSize: token.fontSizeSM,
					lineHeight: "16px",
					color: token.colorPrimary,
					backgroundColor: token.colorBgContainer,
					paddingRight: 6,
				}}
			>
				<EnterOutlined style={{ fontSize: 12 }} />
				<FormattedMessage id="settings.toolbarCustomizer.lineBreak" />
			</span>
			<TokenDeleteButton
				color={token.colorError}
				style={{ top: -26, right: 0 }}
				onClick={onDelete}
			/>
		</div>
	);
};

/** 常显组合容器：虚线框内平铺 head 与成员 */
const GroupContainer: React.FC<{
	headKey: ToolbarToolKey;
	accepting: boolean;
	children: React.ReactNode;
}> = ({ headKey, accepting, children }) => {
	const { token } = theme.useToken();
	const { setNodeRef, isOver } = useDroppable({
		id: panelContainerId(headKey),
	});

	return (
		<div
			ref={setNodeRef}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 2,
				padding: 2,
				border: `1.5px dashed ${
					isOver || accepting ? token.colorPrimary : token.colorSuccessBorder
				}`,
				borderRadius: token.borderRadius + 2,
				backgroundColor: isOver || accepting ? token.colorPrimaryBg : undefined,
			}}
		>
			{children}
		</div>
	);
};

/** 拖拽排序时的蓝色插入线 */
const InsertMarker: React.FC = () => {
	const { token } = theme.useToken();
	return (
		<div
			style={{
				width: 3,
				height: 34,
				borderRadius: 2,
				backgroundColor: token.colorPrimary,
				flex: "none",
				pointerEvents: "none",
			}}
		/>
	);
};

/** 编辑器工具栏行（作为整体投放目标：拖到空白处追加到末尾） */
const EditorRowArea: React.FC<{ children: React.ReactNode }> = ({
	children,
}) => {
	const { token } = theme.useToken();
	const { setNodeRef, isOver } = useDroppable({ id: ROW_CONTAINER_ID });

	return (
		<div
			ref={setNodeRef}
			style={{
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: token.paddingXS,
				padding: `${token.paddingXXS}px ${token.paddingSM}px`,
				backgroundColor: token.colorBgContainer,
				borderRadius: token.borderRadiusLG,
				boxShadow: `0 0 3px 0px ${token.colorPrimaryHover}`,
				width: "fit-content",
				minHeight: 46,
				outline: isOver ? `1.5px dashed ${token.colorPrimary}` : undefined,
			}}
		>
			{children}
		</div>
	);
};

/** 隐藏托盘 */
const HiddenDropArea: React.FC<{ children: React.ReactNode }> = ({
	children,
}) => {
	const { token } = theme.useToken();
	const { setNodeRef, isOver } = useDroppable({ id: HIDDEN_CONTAINER_ID });

	return (
		<div
			ref={setNodeRef}
			style={{
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: token.paddingXXS,
				padding: `${token.paddingXXS + 2}px`,
				minHeight: 46,
				borderRadius: token.borderRadiusLG,
				border: `1px dashed ${
					isOver ? token.colorPrimary : token.colorBorderSecondary
				}`,
				backgroundColor: isOver
					? token.colorPrimaryBgHover
					: token.colorFillQuaternary,
			}}
		>
			{children}
		</div>
	);
};

const ToolbarCustomizerPane: React.FC<{ toolbarId: ToolbarId }> = ({
	toolbarId,
}) => {
	const { token } = theme.useToken();
	const intl = useIntl();
	const { updateAppSettings } = useContext(AppSettingsActionContext);
	const isPluginReady = useToolPluginReady();
	const { orderedItems, hiddenSet, groupsMap } = useToolbarLayout(toolbarId);

	const [slots, setSlots] = useState<EditorSlot[]>([]);
	const [hiddenKeys, setHiddenKeys] = useState<ToolbarToolKey[]>([]);
	/** 合并目标（拖到图标中心区域时高亮） */
	const [mergeTargetId, setMergeTargetId] = useState<DragId | null>(null);
	/** 元素面板拖入时的插入线位置（slots 下标） */
	const [markerIndex, setMarkerIndex] = useState<number | null>(null);
	const [activeDragId, setActiveDragId] = useState<DragId | null>(null);
	const uidRef = useRef(0);
	const nextUid = useCallback(() => {
		uidRef.current += 1;
		return `t${uidRef.current}`;
	}, []);
	const latestStateRef = useRef({ slots, hiddenKeys });
	latestStateRef.current = { slots, hiddenKeys };
	const markerIndexRef = useRef<number | null>(null);
	markerIndexRef.current = markerIndex;

	/** 从设置构建编辑器槽位 */
	const buildSlotsFromSettings = useCallback((): EditorSlot[] => {
		return orderedItems.map((item): EditorSlot => {
			if (isToolbarToolKey(item)) {
				return {
					kind: "tool",
					key: item,
					members: groupsMap[item] ?? [],
				};
			}
			return { kind: "token", token: item, uid: nextUid() };
		});
	}, [groupsMap, nextUid, orderedItems]);

	// 外部设置变化时（如跨窗口同步）重置本地编辑状态
	useEffect(() => {
		setSlots(buildSlotsFromSettings());
		setHiddenKeys([...hiddenSet]);
	}, [buildSlotsFromSettings, hiddenSet]);

	const persist = useCallback(
		(nextSlots: EditorSlot[], nextHiddenKeys: ToolbarToolKey[]) => {
			const normalized = normalizeEditorSlots(nextSlots);
			const fields = TOOLBAR_SETTINGS_FIELDS[toolbarId];
			const groups: ToolbarGroupsMap = {};
			for (const slot of normalized) {
				if (slot.kind === "tool" && slot.members.length > 0) {
					groups[slot.key] = slot.members;
				}
			}
			const order: ToolbarItem[] = normalized.map((slot) =>
				slot.kind === "tool" ? slot.key : slot.token,
			);
			const patch: Partial<AppSettingsData[AppSettingsGroup.Screenshot]> = {
				[fields.orderKey]: order,
				[fields.groupsKey]: groups,
				[fields.hiddenKey]: nextHiddenKeys,
			};
			updateAppSettings(
				AppSettingsGroup.Screenshot,
				patch,
				true,
				true,
				true,
				true,
				false,
			);
		},
		[toolbarId, updateAppSettings],
	);

	const resetToDefault = useCallback(() => {
		const fields = TOOLBAR_SETTINGS_FIELDS[toolbarId];
		const patch: Partial<AppSettingsData[AppSettingsGroup.Screenshot]> = {
			[fields.orderKey]: [],
			[fields.groupsKey]: {},
			[fields.hiddenKey]: [],
		};
		updateAppSettings(
			AppSettingsGroup.Screenshot,
			patch,
			false,
			true,
			true,
			true,
			false,
		);
	}, [toolbarId, updateAppSettings]);

	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 4 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	/** 从槽位/成员/托盘中摘除一个拖拽 id */
	const removeById = useCallback(
		(state: EditorState, id: DragId): EditorState => {
			const parsed = parseDragId(id);
			if (parsed.kind === "tool") {
				const key = parsed.key;
				const nextSlots = state.slots
					// 先把自身作为独立槽位（含组合主按钮）彻底摘除，避免挪动时残留产生重复 id
					.filter((slot) => !(slot.kind === "tool" && slot.key === key))
					// 再从其他组合的成员列表中摘除
					.map((slot) =>
						slot.kind === "tool" && slot.members.includes(key)
							? {
									...slot,
									members: slot.members.filter((m) => m !== key),
								}
							: slot,
					);
				return {
					slots: nextSlots,
					hiddenKeys: state.hiddenKeys.filter((k) => k !== key),
				};
			}
			if (parsed.kind === "token") {
				return {
					slots: state.slots.filter(
						(slot) => !(slot.kind === "token" && slot.uid === parsed.uid),
					),
					hiddenKeys: state.hiddenKeys,
				};
			}
			return state;
		},
		[],
	);

	/** 查找工具成员所在组合的位置信息 */
	const findMemberLocation = useCallback(
		(state: EditorState, key: ToolbarToolKey) => {
			for (const slot of state.slots) {
				if (slot.kind === "tool" && slot.members.includes(key)) {
					return {
						head: slot.key,
						memberIndex: slot.members.indexOf(key),
					};
				}
			}
			return undefined;
		},
		[],
	);

	const hideKey = useCallback(
		(key: ToolbarToolKey) => {
			const { slots: stateSlots, hiddenKeys: stateHiddenKeys } =
				latestStateRef.current;
			if (stateHiddenKeys.includes(key)) {
				return;
			}
			const nextHiddenKeys = [...stateHiddenKeys, key];
			setHiddenKeys(nextHiddenKeys);
			persist(stateSlots, nextHiddenKeys);
		},
		[persist],
	);

	const restoreKey = useCallback(
		(key: ToolbarToolKey) => {
			const { slots: stateSlots, hiddenKeys: stateHiddenKeys } =
				latestStateRef.current;
			if (!stateHiddenKeys.includes(key)) {
				return;
			}
			const nextHiddenKeys = stateHiddenKeys.filter((k) => k !== key);
			setHiddenKeys(nextHiddenKeys);
			persist(stateSlots, nextHiddenKeys);
		},
		[persist],
	);

	const deleteToken = useCallback(
		(uid: string) => {
			const state = latestStateRef.current;
			const next = removeById(state, tokenChipId(uid));
			if (next !== state) {
				setSlots(next.slots);
				setHiddenKeys(next.hiddenKeys);
				persist(next.slots, next.hiddenKeys);
			}
		},
		[persist, removeById],
	);

	/** 加入指定组合，index 缺省追加 */
	const addMember = useCallback(
		(
			state: EditorState,
			headKey: ToolbarToolKey,
			memberKey: ToolbarToolKey,
			index?: number,
		): EditorState => {
			const extracted = removeById(state, toolChipId(memberKey));
			const nextSlots = extracted.slots.map((slot) => {
				if (slot.kind !== "tool" || slot.key !== headKey) {
					return slot;
				}
				const members = [...slot.members];
				const insertIndex =
					index === undefined || index > members.length
						? members.length
						: Math.max(index, 0);
				members.splice(insertIndex, 0, memberKey);
				return { ...slot, members };
			});
			return { slots: nextSlots, hiddenKeys: extracted.hiddenKeys };
		},
		[removeById],
	);

	/** 拖到目标按钮中心：合并（被拖者若是组合 head，其成员一并并入） */
	const mergeIntoSlot = useCallback(
		(
			state: EditorState,
			targetKey: ToolbarToolKey,
			draggedKey: ToolbarToolKey,
		): EditorState => {
			if (targetKey === draggedKey) {
				return state;
			}
			const extracted = removeById(state, toolChipId(draggedKey));
			const draggedSlot = extracted.slots.find(
				(slot): slot is Extract<EditorSlot, { kind: "tool" }> =>
					slot.kind === "tool" && slot.key === draggedKey,
			);
			const movingKeys = draggedSlot
				? [draggedSlot.key, ...draggedSlot.members]
				: [draggedKey];
			const nextSlots = extracted.slots.map((slot) => {
				if (slot.kind !== "tool" || slot.key !== targetKey) {
					return slot;
				}
				const additions = movingKeys.filter(
					(k) => k !== targetKey && !slot.members.includes(k),
				);
				return { ...slot, members: [...slot.members, ...additions] };
			});
			return { slots: nextSlots, hiddenKeys: extracted.hiddenKeys };
		},
		[removeById],
	);

	/**
	 * 实时移动拖拽 id 到目标 id 相邻位置：
	 * 目标是独立槽位（工具或 token）→ 插入其前后；
	 * 目标是组合成员 → 工具插入成员序列，token 落到组合槽位前后；
	 * token 落点被夹在工具之间；组合 head 不能成为自己组合的成员。
	 */
	const moveNextTo = useCallback(
		(
			state: EditorState,
			dragId: DragId,
			targetId: DragId,
			position: "before" | "after",
		): EditorState => {
			if (dragId === targetId) {
				return state;
			}
			const movingSlot = state.slots.find((slot) => slotIdOf(slot) === dragId);
			if (!movingSlot) {
				return state;
			}
			const extracted = removeById(state, dragId);
			const nextSlots = [...extracted.slots];
			const nextHiddenKeys = [...extracted.hiddenKeys];

			const targetIndex = nextSlots.findIndex(
				(slot) => slotIdOf(slot) === targetId,
			);
			if (targetIndex >= 0) {
				let insertIndex = position === "before" ? targetIndex : targetIndex + 1;
				if (movingSlot.kind === "token") {
					const clamped = clampTokenIndex(nextSlots, insertIndex);
					if (clamped === null) {
						return state;
					}
					insertIndex = clamped;
				}
				nextSlots.splice(insertIndex, 0, movingSlot);
				return { slots: nextSlots, hiddenKeys: nextHiddenKeys };
			}

			const targetParsed = parseDragId(targetId);
			if (targetParsed.kind !== "tool") {
				return state;
			}
			const headIndex = nextSlots.findIndex(
				(slot) =>
					slot.kind === "tool" && slot.members.includes(targetParsed.key),
			);
			if (headIndex < 0) {
				return state;
			}
			const slot = nextSlots[headIndex];
			if (slot.kind !== "tool") {
				return state;
			}
			if (movingSlot.kind === "tool" && movingSlot.key === slot.key) {
				// 组合 head 不能成为自己组合的成员
				return state;
			}
			if (movingSlot.kind === "token") {
				// token 不进组合，落到组合槽位前后
				nextSlots.splice(
					position === "before" ? headIndex : headIndex + 1,
					0,
					movingSlot,
				);
				return { slots: nextSlots, hiddenKeys: nextHiddenKeys };
			}
			const memberIndex = slot.members.indexOf(targetParsed.key);
			const members = [...slot.members];
			members.splice(
				position === "before" ? memberIndex : memberIndex + 1,
				0,
				movingSlot.key,
			);
			nextSlots[headIndex] = { ...slot, members };
			return { slots: nextSlots, hiddenKeys: nextHiddenKeys };
		},
		[removeById],
	);

	const onDragStart = useCallback((event: DragStartEvent) => {
		setActiveDragId(event.active.id as DragId);
	}, []);

	const onDragOver = useCallback(
		(event: DragOverEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) {
				setMergeTargetId(null);
				return;
			}

			const activeParsed = parseDragId(active.id as DragId);
			const overParsed = parseDragId(over.id as DragId);
			const state = latestStateRef.current;

			// 元素面板拖入：仅更新插入线位置
			if (activeParsed.kind === "palette") {
				setMergeTargetId(null);
				let rawIndex: number | null = null;
				if (overParsed.kind === "row") {
					rawIndex = state.slots.length;
				} else if (overParsed.kind === "tool") {
					const slotIndex = state.slots.findIndex(
						(slot) => slot.kind === "tool" && slot.key === overParsed.key,
					);
					if (slotIndex >= 0) {
						const { position } = resolveDropSide(event);
						rawIndex = position === "before" ? slotIndex : slotIndex + 1;
					} else {
						// 目标是组合成员：token 落到组合槽位之后
						const headIndex = state.slots.findIndex(
							(slot) =>
								slot.kind === "tool" && slot.members.includes(overParsed.key),
						);
						if (headIndex >= 0) {
							rawIndex = headIndex + 1;
						}
					}
				} else if (overParsed.kind === "token") {
					const slotIndex = state.slots.findIndex(
						(slot) => slot.kind === "token" && slot.uid === overParsed.uid,
					);
					if (slotIndex >= 0) {
						const { position } = resolveDropSide(event);
						rawIndex = position === "before" ? slotIndex : slotIndex + 1;
					}
				} else if (overParsed.kind === "panel") {
					const headIndex = state.slots.findIndex(
						(slot) => slot.kind === "tool" && slot.key === overParsed.head,
					);
					if (headIndex >= 0) {
						rawIndex = headIndex + 1;
					}
				}
				setMarkerIndex(
					rawIndex === null ? null : clampTokenIndex(state.slots, rawIndex),
				);
				return;
			}

			if (activeParsed.kind !== "tool" && activeParsed.kind !== "token") {
				return;
			}
			setMarkerIndex(null);

			if (overParsed.kind === "container") {
				// 拖入托盘：隐藏（仅工具，槽位与组合关系保留）
				setMergeTargetId(null);
				if (
					activeParsed.kind === "tool" &&
					!state.hiddenKeys.includes(activeParsed.key)
				) {
					setHiddenKeys([...state.hiddenKeys, activeParsed.key]);
				}
				return;
			}

			setMergeTargetId(null);

			if (overParsed.kind === "row") {
				return;
			}

			if (overParsed.kind === "panel") {
				if (
					activeParsed.kind === "tool" &&
					overParsed.head !== activeParsed.key
				) {
					const headSlot = state.slots.find(
						(slot) => slot.kind === "tool" && slot.key === overParsed.head,
					);
					if (
						headSlot &&
						headSlot.kind === "tool" &&
						headSlot.members[headSlot.members.length - 1] !== activeParsed.key
					) {
						const moved = addMember(state, overParsed.head, activeParsed.key);
						if (moved !== state) {
							setSlots(moved.slots);
							setHiddenKeys(moved.hiddenKeys);
						}
					}
				}
				return;
			}

			if (overParsed.kind === "tool") {
				const targetIsTopSlot = state.slots.some(
					(slot) => slot.kind === "tool" && slot.key === overParsed.key,
				);
				const { merge, position } = resolveDropSide(event);
				if (targetIsTopSlot) {
					if (
						merge &&
						activeParsed.kind === "tool" &&
						overParsed.key !== activeParsed.key
					) {
						// 合并在拖拽结束时应用，这里仅高亮
						setMergeTargetId(over.id as DragId);
						return;
					}
					const moved = moveNextTo(
						state,
						active.id as DragId,
						over.id as DragId,
						position,
					);
					if (moved !== state) {
						setSlots(moved.slots);
						setHiddenKeys(moved.hiddenKeys);
					}
					return;
				}
				// 目标是组合成员：中心区域 = 加入组合，边缘 = 插入成员序列
				if (activeParsed.kind !== "tool") {
					return;
				}
				const location = findMemberLocation(state, overParsed.key);
				if (!location) {
					return;
				}
				if (merge && location.head !== activeParsed.key) {
					const moved = addMember(
						state,
						location.head,
						activeParsed.key,
						location.memberIndex + 1,
					);
					if (moved !== state) {
						setSlots(moved.slots);
						setHiddenKeys(moved.hiddenKeys);
					}
					return;
				}
				const moved = moveNextTo(
					state,
					active.id as DragId,
					over.id as DragId,
					position,
				);
				if (moved !== state) {
					setSlots(moved.slots);
					setHiddenKeys(moved.hiddenKeys);
				}
				return;
			}

			if (overParsed.kind === "token") {
				const { position } = resolveDropSide(event);
				const moved = moveNextTo(
					state,
					active.id as DragId,
					over.id as DragId,
					position,
				);
				if (moved !== state) {
					setSlots(moved.slots);
					setHiddenKeys(moved.hiddenKeys);
				}
			}
		},
		[addMember, findMemberLocation, moveNextTo],
	);

	const onDragCancel = useCallback(() => {
		setActiveDragId(null);
		setMergeTargetId(null);
		setMarkerIndex(null);
		setSlots(buildSlotsFromSettings());
		setHiddenKeys([...hiddenSet]);
	}, [buildSlotsFromSettings, hiddenSet]);

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveDragId(null);
			setMergeTargetId(null);
			const state = latestStateRef.current;
			const activeParsed = parseDragId(event.active.id as DragId);

			// 元素面板拖入：按标记位置插入新 token
			if (activeParsed.kind === "palette") {
				const marker = markerIndexRef.current;
				setMarkerIndex(null);
				if (marker !== null) {
					const newSlot: EditorSlot = {
						kind: "token",
						token: activeParsed.token,
						uid: nextUid(),
					};
					const nextSlots = [...state.slots];
					nextSlots.splice(Math.min(marker, nextSlots.length), 0, newSlot);
					setSlots(nextSlots);
					persist(nextSlots, state.hiddenKeys);
				}
				return;
			}

			setMarkerIndex(null);

			if (event.over) {
				const overParsed = parseDragId(event.over.id as DragId);
				if (
					activeParsed.kind === "tool" &&
					overParsed.kind === "tool" &&
					overParsed.key !== activeParsed.key
				) {
					const { merge } = resolveDropSide(event);
					if (merge) {
						const targetIsTopSlot = state.slots.some(
							(slot) => slot.kind === "tool" && slot.key === overParsed.key,
						);
						let next = state;
						if (targetIsTopSlot) {
							next = mergeIntoSlot(state, overParsed.key, activeParsed.key);
						} else {
							const location = findMemberLocation(state, overParsed.key);
							if (location) {
								next = addMember(
									state,
									location.head,
									activeParsed.key,
									location.memberIndex + 1,
								);
							}
						}
						if (next !== state) {
							setSlots(next.slots);
							setHiddenKeys(next.hiddenKeys);
							persist(next.slots, next.hiddenKeys);
						}
						return;
					}
				}
			}

			// 实时移动已在 onDragOver 应用，这里仅持久化最终状态
			persist(state.slots, state.hiddenKeys);
		},
		[addMember, findMemberLocation, mergeIntoSlot, nextUid, persist],
	);

	/** 行内槽位渲染（组合渲染为常显容器） */
	const renderSlot = useCallback(
		(slot: EditorSlot) => {
			if (slot.kind === "token") {
				const dragId = tokenChipId(slot.uid);
				if (slot.token === TOOLBAR_ITEM_SEPARATOR) {
					return (
						<SeparatorSlot
							key={dragId}
							dragId={dragId}
							onDelete={() => deleteToken(slot.uid)}
						/>
					);
				}
				return (
					<LineBreakSlot
						key={dragId}
						dragId={dragId}
						onDelete={() => deleteToken(slot.uid)}
					/>
				);
			}

			const definition = TOOLBAR_TOOL_DEFINITIONS[slot.key];
			if (!definition) {
				return null;
			}
			const hidden = hiddenKeys.includes(slot.key);
			const title = intl.formatMessage({ id: definition.i18nId });
			const grouped = slot.members.length > 0;

			const headChip = (
				<ToolButtonChip
					dragId={toolChipId(slot.key)}
					icon={definition.icon}
					title={title}
					dimmed={!isPluginReady(slot.key)}
					mergeTarget={
						activeDragId !== null && mergeTargetId === toolChipId(slot.key)
					}
					eyeAction={hidden ? "show" : "hide"}
					onEyeClick={() => (hidden ? restoreKey(slot.key) : hideKey(slot.key))}
				/>
			);

			if (!grouped) {
				return <Fragment key={slot.key}>{headChip}</Fragment>;
			}

			const mergeTargeted = mergeTargetId === toolChipId(slot.key);
			return (
				<Fragment key={slot.key}>
					<GroupContainer headKey={slot.key} accepting={mergeTargeted}>
						<div style={{ position: "relative", display: "inline-flex" }}>
							{headChip}
							{mergeTargeted && (
								<span
									style={{
										position: "absolute",
										top: -30,
										left: "50%",
										transform: "translateX(-50%)",
										backgroundColor: token.colorPrimary,
										color: token.colorWhite,
										fontSize: token.fontSizeSM,
										lineHeight: "20px",
										padding: "0 8px",
										borderRadius: token.borderRadius,
										whiteSpace: "nowrap",
										zIndex: 40,
										pointerEvents: "none",
									}}
								>
									<FormattedMessage id="settings.toolbarCustomizer.mergeHint" />
								</span>
							)}
						</div>
						{slot.members.map((memberKey) => {
							const memberDefinition = TOOLBAR_TOOL_DEFINITIONS[memberKey];
							if (!memberDefinition) {
								return null;
							}
							const memberHidden = hiddenKeys.includes(memberKey);
							return (
								<ToolButtonChip
									key={memberKey}
									dragId={toolChipId(memberKey)}
									icon={memberDefinition.icon}
									title={intl.formatMessage({
										id: memberDefinition.i18nId,
									})}
									dimmed={!isPluginReady(memberKey) || memberHidden}
									eyeAction={memberHidden ? "show" : "hide"}
									onEyeClick={() =>
										memberHidden ? restoreKey(memberKey) : hideKey(memberKey)
									}
								/>
							);
						})}
					</GroupContainer>
				</Fragment>
			);
		},
		[
			activeDragId,
			deleteToken,
			hiddenKeys,
			hideKey,
			intl,
			isPluginReady,
			mergeTargetId,
			restoreKey,
			token,
		],
	);

	/** 托盘中的隐藏工具按钮 */
	const renderHiddenChip = useCallback(
		(key: ToolbarToolKey) => {
			const definition = TOOLBAR_TOOL_DEFINITIONS[key];
			if (!definition) {
				return null;
			}
			return (
				<ToolButtonChip
					key={key}
					dragId={toolChipId(key)}
					icon={definition.icon}
					title={intl.formatMessage({ id: definition.i18nId })}
					dimmed={!isPluginReady(key)}
					eyeAction="show"
					onEyeClick={() => restoreKey(key)}
				/>
			);
		},
		[isPluginReady, intl, restoreKey],
	);

	/** 拖拽跟随预览 */
	const renderDragOverlay = useCallback(() => {
		if (!activeDragId) {
			return null;
		}
		const parsed = parseDragId(activeDragId);
		if (parsed.kind === "tool") {
			const definition = TOOLBAR_TOOL_DEFINITIONS[parsed.key];
			if (!definition) {
				return null;
			}
			const slot = slots.find(
				(item) => item.kind === "tool" && item.key === parsed.key,
			);
			const memberCount =
				slot && slot.kind === "tool" ? slot.members.length : 0;
			return (
				<div
					style={{
						position: "relative",
						display: "inline-flex",
						opacity: 0.9,
						outline: `2px solid ${token.colorPrimary}`,
						borderRadius: token.borderRadius,
						backgroundColor: token.colorBgContainer,
					}}
				>
					<Button icon={definition.icon} type="text" />
					{memberCount > 0 && (
						<span
							style={{
								position: "absolute",
								top: -8,
								right: -8,
								minWidth: 16,
								height: 16,
								padding: "0 4px",
								backgroundColor: token.colorSuccess,
								color: token.colorWhite,
								borderRadius: 8,
								fontSize: 11,
								lineHeight: "16px",
								textAlign: "center",
							}}
						>
							{memberCount + 1}
						</span>
					)}
				</div>
			);
		}
		if (parsed.kind === "palette" || parsed.kind === "token") {
			const tokenKind = parsed.kind === "palette" ? parsed.token : null;
			const resolvedToken =
				tokenKind ??
				(() => {
					if (parsed.kind !== "token") {
						return null;
					}
					const slot = slots.find(
						(item) => item.kind === "token" && item.uid === parsed.uid,
					);
					return slot && slot.kind === "token" ? slot.token : null;
				})();
			if (!resolvedToken) {
				return null;
			}
			if (resolvedToken === TOOLBAR_ITEM_SEPARATOR) {
				return (
					<span
						style={{
							display: "inline-flex",
							width: 10,
							height: 34,
							alignItems: "center",
							justifyContent: "center",
							backgroundColor: token.colorBgContainer,
							outline: `2px solid ${token.colorPrimary}`,
							borderRadius: 4,
						}}
					>
						<i
							style={{
								width: 2,
								height: 24,
								backgroundColor: token.colorBorder,
								borderRadius: 1,
							}}
						/>
					</span>
				);
			}
			return (
				<span
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
						padding: "4px 10px",
						backgroundColor: token.colorBgContainer,
						outline: `2px solid ${token.colorPrimary}`,
						borderRadius: token.borderRadius,
						fontSize: token.fontSizeSM,
					}}
				>
					<EnterOutlined />
					<FormattedMessage id="settings.toolbarCustomizer.lineBreak" />
				</span>
			);
		}
		return null;
	}, [activeDragId, slots, token]);

	const visibleSlots = useMemo(
		() =>
			slots.filter(
				(slot) => !(slot.kind === "tool" && hiddenKeys.includes(slot.key)),
			),
		[slots, hiddenKeys],
	);

	const hiddenSlotKeys = useMemo(
		() => hiddenKeys.filter((key) => TOOLBAR_TOOL_DEFINITIONS[key]),
		[hiddenKeys],
	);

	const stats = useMemo(() => {
		const slotCount = visibleSlots.filter(
			(slot) => slot.kind === "tool",
		).length;
		const groupCount = visibleSlots.filter(
			(slot) => slot.kind === "tool" && slot.members.length > 0,
		).length;
		const rowCount =
			visibleSlots.filter(
				(slot) =>
					slot.kind === "token" && slot.token === TOOLBAR_ITEM_LINE_BREAK,
			).length + 1;
		return { slotCount, groupCount, rowCount };
	}, [visibleSlots]);

	return (
		<div className="toolbar-editor">
			<DndContext
				sensors={sensors}
				collisionDetection={nestedFirstCollisionDetection}
				onDragStart={onDragStart}
				onDragOver={onDragOver}
				onDragEnd={onDragEnd}
				onDragCancel={onDragCancel}
			>
				<div
					style={{
						marginBottom: token.marginSM,
						color: token.colorTextDescription,
						fontSize: token.fontSizeSM,
					}}
				>
					<FormattedMessage id="settings.toolbarCustomizer.tip" />
				</div>

				<div
					style={{
						marginBottom: token.marginSM,
						display: "flex",
						alignItems: "center",
						gap: token.marginSM,
						flexWrap: "wrap",
					}}
				>
					<span style={{ fontWeight: 500 }}>
						<FormattedMessage id="settings.toolbarCustomizer.elements" />
					</span>
					<PaletteChip
						dragId={PALETTE_SEPARATOR_ID}
						icon={<LineOutlined />}
						label={intl.formatMessage({
							id: "settings.toolbarCustomizer.separator",
						})}
					/>
					<PaletteChip
						dragId={PALETTE_LINE_BREAK_ID}
						icon={<EnterOutlined />}
						label={intl.formatMessage({
							id: "settings.toolbarCustomizer.lineBreak",
						})}
					/>
					<span
						style={{
							fontSize: token.fontSizeSM,
							color: token.colorTextDescription,
						}}
					>
						<FormattedMessage id="settings.toolbarCustomizer.paletteHint" />
					</span>
				</div>

				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: token.marginXXS,
					}}
				>
					<span style={{ fontWeight: 500 }}>
						<FormattedMessage
							id="settings.toolbarCustomizer.stats"
							values={{
								slots: stats.slotCount,
								groups: stats.groupCount,
								rows: stats.rowCount,
							}}
						/>
					</span>
					<Button size="small" icon={<RestOutlined />} onClick={resetToDefault}>
						<FormattedMessage id="settings.toolbarCustomizer.reset" />
					</Button>
				</div>

				<SortableContext
					items={visibleSlots.map((slot) => slotIdOf(slot))}
					id={ROW_CONTAINER_ID}
				>
					<EditorRowArea>
						{visibleSlots.map((slot, index) => (
							<Fragment key={slotIdOf(slot)}>
								{markerIndex === index && <InsertMarker />}
								{renderSlot(slot)}
							</Fragment>
						))}
						{markerIndex !== null && markerIndex >= visibleSlots.length && (
							<InsertMarker />
						)}
					</EditorRowArea>
				</SortableContext>

				<div
					style={{
						fontWeight: 500,
						margin: `${token.marginSM}px 0 ${token.marginXXS}px`,
					}}
				>
					<FormattedMessage id="settings.toolbarCustomizer.hiddenTools" />
				</div>
				<SortableContext
					items={hiddenSlotKeys.map((key) => toolChipId(key))}
					id={HIDDEN_CONTAINER_ID}
				>
					<HiddenDropArea>
						{hiddenSlotKeys.map((key) => renderHiddenChip(key))}
						{hiddenSlotKeys.length === 0 && (
							<span
								style={{
									color: token.colorTextQuaternary,
									fontSize: token.fontSizeSM,
								}}
							>
								<FormattedMessage id="settings.toolbarCustomizer.hiddenToolsEmpty" />
							</span>
						)}
					</HiddenDropArea>
				</SortableContext>

				<DragOverlay style={{ pointerEvents: "none" }}>
					{renderDragOverlay()}
				</DragOverlay>
			</DndContext>

			<style jsx>{`
				.toolbar-editor :global(.ant-btn) {
					padding-inline: 10px;
				}
				.toolbar-editor :global(.ant-btn-icon) {
					font-size: 22px;
					display: flex;
					align-items: center;
				}
				.toolbar-editor-token:hover {
					background-color: ${token.colorPrimaryBg};
				}
				.toolbar-editor-token
					:hover
					:global(.toolbar-editor-mini-btn) {
					display: flex !important;
				}
			`}</style>
		</div>
	);
};

/**
 * 工具栏可视化编辑器（Tabs 切换三种工具栏）：
 * - 拖拽实时排序；拖到另一个图标中心合并为组合（常显虚线容器，成员可拖出、跨容器移动）；
 * - 元素面板可拖入显式分隔符与换行（新建一行），悬停可删除；
 * - 下方灰显托盘收纳隐藏的工具。配置实时持久化并同步到画布。
 */
export const ToolbarCustomizer: React.FC = () => {
	const items = useMemo(
		() => [
			{
				key: ToolbarId.Main,
				label: <FormattedMessage id="settings.toolbarSettings.mainToolbar" />,
				children: <ToolbarCustomizerPane toolbarId={ToolbarId.Main} />,
			},
			{
				key: ToolbarId.FullScreen,
				label: (
					<FormattedMessage id="settings.toolbarSettings.fullScreenDrawToolbar" />
				),
				children: <ToolbarCustomizerPane toolbarId={ToolbarId.FullScreen} />,
			},
			{
				key: ToolbarId.FixedContent,
				label: (
					<FormattedMessage id="settings.toolbarSettings.fixedContentToolbar" />
				),
				children: <ToolbarCustomizerPane toolbarId={ToolbarId.FixedContent} />,
			},
		],
		[],
	);

	return (
		<Tabs
			defaultActiveKey={ToolbarId.Main}
			items={items}
			destroyInactiveTabPane
		/>
	);
};
