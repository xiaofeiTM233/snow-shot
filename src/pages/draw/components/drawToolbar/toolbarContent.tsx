import type React from "react";
import {
	TOOLBAR_TOOL_DEFINITIONS,
	type ToolbarToolGroup,
} from "@/constants/toolbarTools";
import type { ToolbarGroupsMap, ToolbarToolKey } from "@/types/toolbarTool";

/**
 * 按顺序渲染工具栏内容：
 * - 相邻可见工具的分组变化时自动插入分隔线；
 * - 用户配置隐藏的工具保持挂载，仅通过 display:none 隐藏，快捷键仍然可用；
 * - renderTool 返回 null 的工具（运行时条件不满足）不渲染；
 * - groupsMap 中有成员的工具通过 renderGroup 渲染为组合（Popover）。
 */
export const buildToolbarContent = (
	orderedKeys: ToolbarToolKey[],
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

	for (const key of orderedKeys) {
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
			if (lastVisibleGroup && lastVisibleGroup !== definition.group) {
				items.push(
					<div className="draw-toolbar-splitter" key={`splitter-${key}`} />,
				);
			}
			lastVisibleGroup = definition.group;
		}

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
