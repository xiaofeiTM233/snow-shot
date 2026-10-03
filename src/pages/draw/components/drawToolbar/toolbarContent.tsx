import type React from "react";
import {
	TOOLBAR_TOOL_DEFINITIONS,
	type ToolbarToolGroup,
} from "@/constants/toolbarTools";
import {
	TOOLBAR_ITEM_LINE_BREAK,
	TOOLBAR_ITEM_SEPARATOR,
	type ToolbarGroupsMap,
	type ToolbarItem,
	type ToolbarToolKey,
} from "@/types/toolbarTool";

/**
 * 按顺序渲染工具栏内容：
 * - 相邻可见工具的分组变化时自动插入分隔线；显式分隔符/换行两侧不再插入自动分隔线；
 * - 显式分隔符渲染为分隔线，显式换行渲染为强制断行元素（父容器需开启 flex wrap）；
 * - 用户配置隐藏的工具保持挂载，仅通过 display:none 隐藏，快捷键仍然可用；
 * - renderTool 返回 null 的工具（运行时条件不满足）不渲染；
 * - groupsMap 中有成员的工具通过 renderGroup 渲染为组合（Popover）。
 */
export const buildToolbarContent = (
	orderedItems: ToolbarItem[],
	hiddenSet: Set<ToolbarToolKey>,
	renderTool: (key: ToolbarToolKey) => React.ReactNode,
	gap: number | string,
	groupsMap?: ToolbarGroupsMap,
	renderGroup?: (
		headKey: ToolbarToolKey,
		members: ToolbarToolKey[],
	) => React.ReactNode,
): React.ReactNode[] => {
	const items: React.ReactNode[] = [];
	let lastVisibleGroup: ToolbarToolGroup | undefined;
	/** 最近渲染的元素是否为显式分隔符/换行（此时抑制自动分隔线） */
	let afterExplicitSplit = false;

	for (const item of orderedItems) {
		if (item === TOOLBAR_ITEM_SEPARATOR) {
			items.push(
				<div
					className="draw-toolbar-splitter"
					key={`separator-${items.length}`}
				/>,
			);
			lastVisibleGroup = undefined;
			afterExplicitSplit = true;
			continue;
		}
		if (item === TOOLBAR_ITEM_LINE_BREAK) {
			items.push(
				<div
					className="draw-toolbar-line-break"
					key={`line-break-${items.length}`}
					style={{ flexBasis: "100%", height: 0 }}
				/>,
			);
			lastVisibleGroup = undefined;
			afterExplicitSplit = true;
			continue;
		}

		const key = item;
		const definition = TOOLBAR_TOOL_DEFINITIONS[key];
		if (!definition) {
			continue;
		}
		const configHidden = hiddenSet.has(key);
		const members = groupsMap?.[key];
		const node =
			members && members.length > 0 && renderGroup
				? renderGroup(key, members)
				: renderTool(key);
		if (!node) {
			continue;
		}

		if (!configHidden) {
			if (
				lastVisibleGroup &&
				lastVisibleGroup !== definition.group &&
				!afterExplicitSplit
			) {
				items.push(
					<div className="draw-toolbar-splitter" key={`splitter-${key}`} />,
				);
			}
			lastVisibleGroup = definition.group;
		}
		afterExplicitSplit = false;

		items.push(
			<div
				key={key}
				className="draw-toolbar-tool-slot"
				style={{
					display: configHidden ? "none" : "flex",
					alignItems: "center",
					gap,
				}}
			>
				{node}
			</div>,
		);
	}

	return items;
};
