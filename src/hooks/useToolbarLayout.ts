import { useCallback, useState } from "react";
import { defaultAppSettingsData } from "@/constants/appSettings";
import {
	DEFAULT_TOOLBAR_GROUPS,
	DEFAULT_TOOLBAR_TOOL_ORDER,
	getToolbarAvailableKeys,
	normalizeToolbarGroupsMap,
} from "@/constants/toolbarTools";
import { AppSettingsPublisher } from "@/contexts/appSettingsActionContext";
import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import type { ToolbarGroupsMap, ToolbarToolKey } from "@/types/toolbarTool";
import { ToolbarId } from "@/types/toolbarTool";
import { useStateSubscriber } from "./useStateSubscriber";

export type ToolbarLayout = {
	/** 排序后的顶层槽位键（已按设置补全；组合占一个槽位，键为 head） */
	orderedKeys: ToolbarToolKey[];
	/** 隐藏的工具键集合 */
	hiddenSet: Set<ToolbarToolKey>;
	/** 组合成员表（head → 成员键，已过滤隐藏与本槽位重复项） */
	groupsMap: ToolbarGroupsMap;
};

type ScreenshotSettings = AppSettingsData[AppSettingsGroup.Screenshot];

const TOOLBAR_ORDER_SETTINGS_KEY: Record<ToolbarId, keyof ScreenshotSettings> =
	{
		[ToolbarId.Main]: "toolbarToolOrder",
		[ToolbarId.FullScreen]: "fullScreenToolbarToolOrder",
		[ToolbarId.FixedContent]: "fixedContentToolbarToolOrder",
	};

const TOOLBAR_GROUPS_SETTINGS_KEY: Record<ToolbarId, keyof ScreenshotSettings> =
	{
		[ToolbarId.Main]: "toolbarGroups",
		[ToolbarId.FullScreen]: "fullScreenToolbarGroups",
		[ToolbarId.FixedContent]: "fixedContentToolbarGroups",
	};

const TOOLBAR_HIDDEN_SETTINGS_KEY: Record<ToolbarId, keyof ScreenshotSettings> =
	{
		[ToolbarId.Main]: "toolbarHiddenTools",
		[ToolbarId.FullScreen]: "fullScreenToolbarHiddenTools",
		[ToolbarId.FixedContent]: "fixedContentToolbarHiddenTools",
	};

/** 根据设置解析工具栏布局：排序补全 + 组合校验 + 隐藏集合过滤 */
export const resolveToolbarLayout = (
	toolbarId: ToolbarId,
	screenshotSettings: ScreenshotSettings,
): ToolbarLayout => {
	const defaultOrder = DEFAULT_TOOLBAR_TOOL_ORDER[toolbarId];
	const defaultOrderSet = new Set(defaultOrder);
	const availableKeys = getToolbarAvailableKeys(toolbarId);

	const savedOrder = screenshotSettings[
		TOOLBAR_ORDER_SETTINGS_KEY[toolbarId]
	] as ToolbarToolKey[] | undefined;
	const orderedKeys: ToolbarToolKey[] = [];
	const seenKeys = new Set<ToolbarToolKey>();
	for (const key of savedOrder ?? []) {
		if (defaultOrderSet.has(key) && !seenKeys.has(key)) {
			seenKeys.add(key);
			orderedKeys.push(key);
		}
	}
	// 设置中缺失的工具按默认顺序追加到末尾，保证未来新增工具的向前兼容
	for (const key of defaultOrder) {
		if (!seenKeys.has(key)) {
			orderedKeys.push(key);
		}
	}

	const savedHidden = screenshotSettings[
		TOOLBAR_HIDDEN_SETTINGS_KEY[toolbarId]
	] as ToolbarToolKey[] | undefined;
	const hiddenSet = new Set<ToolbarToolKey>();
	for (const key of savedHidden ?? []) {
		if (availableKeys.has(key)) {
			hiddenSet.add(key);
		}
	}

	const orderSet = new Set(orderedKeys);
	const groups: ToolbarGroupsMap = {};
	const savedGroups = normalizeToolbarGroupsMap(
		screenshotSettings[TOOLBAR_GROUPS_SETTINGS_KEY[toolbarId]],
		availableKeys,
		DEFAULT_TOOLBAR_GROUPS[toolbarId],
	);
	for (const [head, members] of Object.entries(savedGroups)) {
		const headKey = head as ToolbarToolKey;
		// 出现在顺序中的键是独立槽位，不能同时是其他组合的成员
		const filteredMembers = (members ?? []).filter(
			(member) => !orderSet.has(member),
		);
		if (filteredMembers.length > 0) {
			groups[headKey] = filteredMembers;
		}
	}

	return { orderedKeys, hiddenSet, groupsMap: groups };
};

/**
 * 订阅应用设置，解析指定工具栏的布局（顺序 + 隐藏集合 + 组合），设置变化时实时更新。
 */
export const useToolbarLayout = (toolbarId: ToolbarId): ToolbarLayout => {
	const [layout, setLayout] = useState<ToolbarLayout>(() =>
		resolveToolbarLayout(
			toolbarId,
			defaultAppSettingsData[AppSettingsGroup.Screenshot],
		),
	);

	useStateSubscriber(
		AppSettingsPublisher,
		useCallback(
			(settings: AppSettingsData) => {
				setLayout(
					resolveToolbarLayout(
						toolbarId,
						settings[AppSettingsGroup.Screenshot],
					),
				);
			},
			[toolbarId],
		),
	);

	return layout;
};

/** 查找工具所属的组合 head（若该工具是某组合的成员则返回 head，否则返回 undefined） */
export const findToolGroupHead = (
	toolKey: ToolbarToolKey,
	groupsMap: ToolbarGroupsMap,
): ToolbarToolKey | undefined => {
	for (const [head, members] of Object.entries(groupsMap)) {
		if (members?.includes(toolKey)) {
			return head as ToolbarToolKey;
		}
	}
	return undefined;
};
