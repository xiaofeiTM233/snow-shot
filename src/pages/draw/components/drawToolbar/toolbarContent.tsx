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
 * 按顺序构建工具栏内容，返回行数组：
 * - 无显式换行时返回单行（调用点渲染为单行 flex，与旧版布局一致）；
 * - 显式换行切分行，每行由调用点渲染为独立的不换行 flex 行容器
 *   （工具栏是 absolute shrink-to-fit 容器，flex-wrap 会使宽度塌缩到最宽单项导致竖排，
 *   因此多行必须按行切分渲染，每行宽度独立收缩）；
 * - 相邻可见工具的分组变化时自动插入分隔线；显式分隔符/换行两侧不再插入自动分隔线；
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
): { key: string; items: React.ReactNode[] }[] => {
	const rows: { key: string; items: React.ReactNode[] }[] = [];
	let currentRow: React.ReactNode[] = [];
	let lastVisibleGroup: ToolbarToolGroup | undefined;
	/** 最近渲染的元素是否为显式分隔符/换行（此时抑制自动分隔线） */
	let afterExplicitSplit = false;

	/** 结束当前行（空行丢弃：行首换行无效） */
	const endRow = () => {
		if (currentRow.length > 0) {
			rows.push({ key: `row-${rows.length}`, items: currentRow });
			currentRow = [];
		}
	};

	for (const item of orderedItems) {
		if (item === TOOLBAR_ITEM_SEPARATOR) {
			currentRow.push(
				<div
					className="draw-toolbar-splitter"
					key={`separator-${rows.length}-${currentRow.length}`}
				/>,
			);
			lastVisibleGroup = undefined;
			afterExplicitSplit = true;
			continue;
		}
		if (item === TOOLBAR_ITEM_LINE_BREAK) {
			endRow();
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
				currentRow.push(
					<div
						className="draw-toolbar-splitter"
						key={`splitter-${rows.length}-${key}`}
					/>,
				);
			}
			lastVisibleGroup = definition.group;
		}
		afterExplicitSplit = false;

		currentRow.push(
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
	endRow();

	return rows.length > 0 ? rows : [{ key: "row-0", items: [] }];
};
