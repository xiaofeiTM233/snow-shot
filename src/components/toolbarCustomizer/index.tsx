import {
	EyeInvisibleOutlined,
	EyeOutlined,
	RestOutlined,
} from "@ant-design/icons";
import {
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	KeyboardSensor,
	PointerSensor,
	pointerWithin,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
} from "@dnd-kit/sortable";
import { Button, Tooltip, theme } from "antd";
import {
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
import { TOOLBAR_TOOL_DEFINITIONS } from "@/constants/toolbarTools";
import { AppSettingsActionContext } from "@/contexts/appSettingsActionContext";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { useToolbarLayout } from "@/hooks/useToolbarLayout";
import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import {
	type ToolbarGroupsMap,
	ToolbarId,
	ToolbarToolKey,
} from "@/types/toolbarTool";

const HIDDEN_CONTAINER_ID = "toolbar-editor-hidden";
const PANEL_CONTAINER_PREFIX = "toolbar-editor-panel:";

type EditorSlot = {
	key: ToolbarToolKey;
	members: ToolbarToolKey[];
};

type EditorState = {
	slots: EditorSlot[];
	hiddenKeys: ToolbarToolKey[];
};

type DragId = string;

/** 所有芯片统一使用 tool:${key}，跨容器移动时 id 保持稳定，拖拽不中断 */
const toolChipId = (key: ToolbarToolKey): DragId => `tool:${key}`;
const panelContainerId = (head: ToolbarToolKey): DragId =>
	`${PANEL_CONTAINER_PREFIX}${head}`;

type ParsedDragId =
	| { kind: "tool"; key: ToolbarToolKey }
	| { kind: "panel"; head: ToolbarToolKey }
	| { kind: "container"; name: "hidden" }
	| { kind: "unknown" };

const parseDragId = (id: string): ParsedDragId => {
	if (id === HIDDEN_CONTAINER_ID) {
		return { kind: "container", name: "hidden" };
	}
	if (id.startsWith(PANEL_CONTAINER_PREFIX)) {
		return {
			kind: "panel",
			head: id.slice(PANEL_CONTAINER_PREFIX.length) as ToolbarToolKey,
		};
	}
	if (id.startsWith("tool:")) {
		return { kind: "tool", key: id.slice(5) as ToolbarToolKey };
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

/** 工具栏形态的图标按钮（与画布工具栏同款视觉），整颗按钮可拖拽 */
const ToolButtonChip: React.FC<{
	dragId: DragId;
	icon: React.ReactNode;
	title: string;
	dimmed?: boolean;
	highlight?: boolean;
	/** 组合标识：右下角圆点，悬停弹出成员面板 */
	grouped?: boolean;
	/** 悬停时显示的眼睛按钮动作 */
	eyeAction?: "hide" | "show";
	onEyeClick?: () => void;
}> = ({
	dragId,
	icon,
	title,
	dimmed,
	highlight,
	grouped,
	eyeAction,
	onEyeClick,
}) => {
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
				outline: highlight
					? `2px solid ${token.colorPrimary}`
					: "2px solid transparent",
			}}
		>
			<Button icon={icon} title={title} type="text" />
			{grouped && (
				<span
					style={{
						position: "absolute",
						right: 3,
						bottom: 3,
						width: 6,
						height: 6,
						borderRadius: "50%",
						backgroundColor: token.colorPrimary,
						pointerEvents: "none",
					}}
				/>
			)}
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

/** 组合成员面板（渲染在按钮上方，同画布工具栏 Popover 形态） */
const GroupPanel: React.FC<{
	headKey: ToolbarToolKey;
	members: ToolbarToolKey[];
	renderChip: (key: ToolbarToolKey) => React.ReactNode;
}> = ({ headKey, members, renderChip }) => {
	const { token } = theme.useToken();
	const { setNodeRef, isOver } = useDroppable({
		id: panelContainerId(headKey),
	});

	return (
		<div
			ref={setNodeRef}
			style={{
				position: "absolute",
				bottom: "calc(100% + 8px)",
				left: "50%",
				transform: "translateX(-50%)",
				display: "flex",
				alignItems: "center",
				gap: token.paddingXS,
				padding: `${token.paddingXXS}px ${token.paddingSM}px`,
				backgroundColor: token.colorBgContainer,
				borderRadius: token.borderRadiusLG,
				boxShadow: `0 0 3px 0px ${token.colorPrimaryHover}`,
				border: isOver ? `1px solid ${token.colorPrimary}` : undefined,
				whiteSpace: "nowrap",
				zIndex: 10,
			}}
		>
			{members.map((memberKey) => renderChip(memberKey))}
		</div>
	);
};

/**
 * 工具栏可视化编辑器：渲染为一条与画布工具栏同形态的图标工具栏。
 * - 拖拽实时排序；拖到另一个图标中心合并为组合（带圆点角标，悬停弹出成员面板）；
 * - 面板内成员可拖出、可移动到其他组合；组合只剩一个成员时自动解散；
 * - 下方灰显托盘收纳隐藏的工具。配置实时持久化并同步到画布。
 */
export const ToolbarCustomizer: React.FC<{ toolbarId: ToolbarId }> = ({
	toolbarId,
}) => {
	const { token } = theme.useToken();
	const intl = useIntl();
	const { updateAppSettings } = useContext(AppSettingsActionContext);
	const isPluginReady = useToolPluginReady();
	const { orderedKeys, hiddenSet, groupsMap } = useToolbarLayout(toolbarId);

	const [slots, setSlots] = useState<EditorSlot[]>([]);
	const [hiddenKeys, setHiddenKeys] = useState<ToolbarToolKey[]>([]);
	const [hoveredHead, setHoveredHead] = useState<ToolbarToolKey | null>(null);
	const [highlightId, setHighlightId] = useState<DragId | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const latestStateRef = useRef({ slots, hiddenKeys });
	latestStateRef.current = { slots, hiddenKeys };

	// 外部设置变化时（如跨窗口同步）重置本地编辑状态
	useEffect(() => {
		setSlots(
			orderedKeys.map((key) => ({
				key,
				members: groupsMap[key] ?? [],
			})),
		);
		setHiddenKeys([...hiddenSet]);
	}, [orderedKeys, hiddenSet, groupsMap]);

	const persist = useCallback(
		(nextSlots: EditorSlot[], nextHiddenKeys: ToolbarToolKey[]) => {
			const fields = TOOLBAR_SETTINGS_FIELDS[toolbarId];
			const groups: ToolbarGroupsMap = {};
			for (const slot of nextSlots) {
				if (slot.members.length > 0) {
					groups[slot.key] = slot.members;
				}
			}
			const patch: Partial<AppSettingsData[AppSettingsGroup.Screenshot]> = {
				[fields.orderKey]: nextSlots.map((slot) => slot.key),
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

	/** 从行内/面板/托盘中提取一个键（组合 head 的槽位保留，仅移除成员关系） */
	const removeKey = useCallback(
		(state: EditorState, key: ToolbarToolKey): EditorState => {
			const slots = state.slots
				// 先把自身作为独立槽位（含组合主按钮）彻底摘除，避免挪动时残留产生重复 id
				.filter((slot) => slot.key !== key)
				// 再从其他组合的成员列表中摘除
				.map((slot) => {
					if (slot.members.includes(key)) {
						return { ...slot, members: slot.members.filter((m) => m !== key) };
					}
					return slot;
				});
			const hiddenKeys = state.hiddenKeys.filter((k) => k !== key);
			return { slots, hiddenKeys };
		},
		[],
	);

	const hideKey = useCallback(
		(key: ToolbarToolKey) => {
			const { slots, hiddenKeys } = latestStateRef.current;
			if (hiddenKeys.includes(key)) {
				return;
			}
			const nextHiddenKeys = [...hiddenKeys, key];
			setHiddenKeys(nextHiddenKeys);
			persist(slots, nextHiddenKeys);
		},
		[persist],
	);

	const restoreKey = useCallback(
		(key: ToolbarToolKey) => {
			const { slots, hiddenKeys } = latestStateRef.current;
			if (!hiddenKeys.includes(key)) {
				return;
			}
			const nextHiddenKeys = hiddenKeys.filter((k) => k !== key);
			setHiddenKeys(nextHiddenKeys);
			persist(slots, nextHiddenKeys);
		},
		[persist],
	);

	/** 加入指定组合，index 缺省追加 */
	const addMember = useCallback(
		(
			state: EditorState,
			headKey: ToolbarToolKey,
			memberKey: ToolbarToolKey,
			index?: number,
		): EditorState => {
			const extracted = removeKey(state, memberKey);
			const slots = extracted.slots.map((slot) => {
				if (slot.key !== headKey) {
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
			return { slots, hiddenKeys: extracted.hiddenKeys };
		},
		[removeKey],
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
			const extracted = removeKey(state, draggedKey);
			const draggedSlot = extracted.slots.find(
				(slot) => slot.key === draggedKey,
			);
			const movingKeys = draggedSlot
				? [draggedSlot.key, ...draggedSlot.members]
				: [draggedKey];
			const slots = extracted.slots
				.filter((slot) => slot.key !== draggedKey)
				.map((slot) => {
					if (slot.key !== targetKey) {
						return slot;
					}
					const additions = movingKeys.filter(
						(k) => k !== targetKey && !slot.members.includes(k),
					);
					return { ...slot, members: [...slot.members, ...additions] };
				});
			return { slots, hiddenKeys: extracted.hiddenKeys };
		},
		[removeKey],
	);

	/**
	 * 实时移动 key 到 targetKey 相邻位置：
	 * target 在行内 → 作为独立槽位插入前后；target 是组合成员 → 插入成员序列；
	 * target 在托盘 → 移入托盘并排序。
	 */
	const moveNextTo = useCallback(
		(
			state: EditorState,
			key: ToolbarToolKey,
			targetKey: ToolbarToolKey,
			position: "before" | "after",
		): EditorState => {
			if (key === targetKey) {
				return state;
			}
			// 保留被移动项的原始槽位（组合主按钮需连带其成员一起挪动，避免拖拽排序时丢失成员）
			const movingSlot = state.slots.find((slot) => slot.key === key);
			const extracted = removeKey(state, key);
			const slots = [...extracted.slots];
			const hiddenKeys = [...extracted.hiddenKeys];

			const targetHiddenIndex = hiddenKeys.indexOf(targetKey);
			if (targetHiddenIndex >= 0) {
				hiddenKeys.splice(
					position === "before" ? targetHiddenIndex : targetHiddenIndex + 1,
					0,
					key,
				);
				if (!hiddenKeys.includes(key)) {
					hiddenKeys.push(key);
				}
				return { slots, hiddenKeys };
			}

			const targetIndex = slots.findIndex((slot) => slot.key === targetKey);
			if (targetIndex >= 0) {
				slots.splice(
					position === "before" ? targetIndex : targetIndex + 1,
					0,
					movingSlot ?? { key, members: [] },
				);
				return { slots, hiddenKeys };
			}

			const headIndex = slots.findIndex((slot) =>
				slot.members.includes(targetKey),
			);
			if (headIndex >= 0) {
				const slot = slots[headIndex];
				const memberIndex = slot.members.indexOf(targetKey);
				const members = [...slot.members];
				members.splice(
					position === "before" ? memberIndex : memberIndex + 1,
					0,
					key,
				);
				slots[headIndex] = { ...slot, members };
				return { slots, hiddenKeys };
			}

			return state;
		},
		[removeKey],
	);

	/** 计算指针相对投放目标的合并判定与前后位置（指针落在目标中间 40% 区域视为合并） */
	const resolveDropSide = useCallback(
		(event: DragEndEvent | DragOverEvent): {
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
		},
		[],
	);

	const onDragStart = useCallback(() => {
		setIsDragging(true);
	}, []);

	const onDragOver = useCallback(
		(event: DragOverEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) {
				setHighlightId(null);
				return;
			}

			const activeParsed = parseDragId(active.id as DragId);
			const overParsed = parseDragId(over.id as DragId);
			if (
				activeParsed.kind !== "tool" ||
				(overParsed.kind !== "tool" &&
					overParsed.kind !== "panel" &&
					overParsed.kind !== "container")
			) {
				return;
			}
			const activeKey = activeParsed.key;
			setHighlightId(over.id as DragId);

			const state = latestStateRef.current;

			if (overParsed.kind === "container") {
				// 拖入托盘：隐藏（槽位与组合关系保留）
				if (!state.hiddenKeys.includes(activeKey)) {
					setHiddenKeys([...state.hiddenKeys, activeKey]);
				}
				return;
			}

			if (overParsed.kind === "panel") {
				const headSlot = state.slots.find(
					(slot) => slot.key === overParsed.head,
				);
				if (
					headSlot &&
					headSlot.members[headSlot.members.length - 1] !== activeKey &&
					overParsed.head !== activeKey
				) {
					const moved = addMember(state, overParsed.head, activeKey);
					if (moved !== state) {
						setSlots(moved.slots);
						setHiddenKeys(moved.hiddenKeys);
					}
				}
				return;
			}

			const { merge, position } = resolveDropSide(event);
			if (merge) {
				// 合并在拖拽结束时应用，这里仅高亮
				return;
			}

			const moved = moveNextTo(
				state,
				activeKey,
				overParsed.key,
				position,
			);
			if (moved !== state) {
				setSlots(moved.slots);
				setHiddenKeys(moved.hiddenKeys);
			}
		},
		[addMember, moveNextTo, resolveDropSide],
	);

	const onDragCancel = useCallback(() => {
		setIsDragging(false);
		setHighlightId(null);
		setSlots(
			orderedKeys.map((key) => ({ key, members: groupsMap[key] ?? [] })),
		);
		setHiddenKeys([...hiddenSet]);
	}, [orderedKeys, hiddenSet, groupsMap]);

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			setIsDragging(false);
			setHighlightId(null);
			const { active, over } = event;
			const state = latestStateRef.current;

			if (over) {
				const activeParsed = parseDragId(active.id as DragId);
				const overParsed = parseDragId(over.id as DragId);
				if (
					activeParsed.kind === "tool" &&
					overParsed.kind === "tool" &&
					overParsed.key !== activeParsed.key
				) {
					const { merge } = resolveDropSide(event);
					if (merge) {
						const next = mergeIntoSlot(
							state,
							overParsed.key,
							activeParsed.key,
						);
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
		[mergeIntoSlot, persist, resolveDropSide],
	);

	/** 行内槽位按钮（组合主按钮带弹出面板） */
	const renderRowSlot = useCallback(
		(slot: EditorSlot) => {
			const definition = TOOLBAR_TOOL_DEFINITIONS[slot.key];
			if (!definition) {
				return null;
			}
			const grouped = slot.members.length > 0;
			const hidden = hiddenKeys.includes(slot.key);
			const title = intl.formatMessage({ id: definition.i18nId });

			return (
				<div
					key={slot.key}
					style={{ position: "relative", display: "inline-flex" }}
					onMouseEnter={grouped ? () => setHoveredHead(slot.key) : undefined}
					onMouseLeave={grouped ? () => setHoveredHead(null) : undefined}
				>
					<ToolButtonChip
						dragId={toolChipId(slot.key)}
						icon={definition.icon}
						title={title}
						dimmed={!isPluginReady(slot.key)}
						highlight={isDragging && highlightId === toolChipId(slot.key)}
						grouped={grouped}
						eyeAction={hidden ? "show" : "hide"}
						onEyeClick={() =>
							hidden ? restoreKey(slot.key) : hideKey(slot.key)
						}
					/>
					{grouped && (hoveredHead === slot.key || isDragging) && (
						<GroupPanel
							headKey={slot.key}
							members={slot.members}
							renderChip={(memberKey) => {
								const memberDefinition =
									TOOLBAR_TOOL_DEFINITIONS[memberKey];
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
										dimmed={!isPluginReady(memberKey)}
										highlight={
											isDragging && highlightId === toolChipId(memberKey)
										}
										eyeAction={memberHidden ? "show" : "hide"}
										onEyeClick={() =>
											memberHidden
												? restoreKey(memberKey)
												: hideKey(memberKey)
										}
									/>
								);
							}}
						/>
					)}
				</div>
			);
		},
		[
			hiddenKeys,
			hideKey,
			hoveredHead,
			highlightId,
			isDragging,
			isPluginReady,
			intl,
			restoreKey,
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
					highlight={isDragging && highlightId === toolChipId(key)}
					eyeAction="show"
					onEyeClick={() => restoreKey(key)}
				/>
			);
		},
		[highlightId, isDragging, isPluginReady, intl, restoreKey],
	);

	const visibleSlots = useMemo(
		() => slots.filter((slot) => !hiddenKeys.includes(slot.key)),
		[slots, hiddenKeys],
	);

	const hiddenSlotKeys = useMemo(
		() => hiddenKeys.filter((key) => TOOLBAR_TOOL_DEFINITIONS[key]),
		[hiddenKeys],
	);

	return (
		<div className="toolbar-editor">
			<DndContext
				sensors={sensors}
				collisionDetection={pointerWithin}
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
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: token.marginXXS,
					}}
				>
					<span style={{ fontWeight: 500 }}>
						<FormattedMessage id="settings.toolbarCustomizer.visibleTools" />
					</span>
					<Button size="small" icon={<RestOutlined />} onClick={resetToDefault}>
						<FormattedMessage id="settings.toolbarCustomizer.reset" />
					</Button>
				</div>

				<SortableContext
					items={visibleSlots.map((slot) => toolChipId(slot.key))}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: token.paddingXS,
							padding: `${token.paddingXXS}px ${token.paddingSM}px`,
							backgroundColor: token.colorBgContainer,
							borderRadius: token.borderRadiusLG,
							boxShadow: `0 0 3px 0px ${token.colorPrimaryHover}`,
							width: "fit-content",
							minHeight: 46,
						}}
					>
						{visibleSlots.map((slot) => renderRowSlot(slot))}
					</div>
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
			`}</style>
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
				border: `1px dashed ${isOver ? token.colorPrimary : token.colorBorderSecondary}`,
				backgroundColor: isOver
					? token.colorPrimaryBgHover
					: token.colorFillQuaternary,
			}}
		>
			{children}
		</div>
	);
};
