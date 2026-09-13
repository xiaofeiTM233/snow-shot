import { Flex, theme } from "antd";
import type React from "react";
import { useMemo } from "react";
import { ToolbarPopover } from "@/pages/draw/components/drawToolbar/components/toolbarPopover";
import type { ToolbarToolKey } from "@/types/toolbarTool";

/**
 * 通用组合槽位：主按钮 + 悬停弹出成员面板（ToolbarPopover）。
 * - 主按钮显示"最后使用的成员"（lastUsedKey），被隐藏或运行时不可见时
 *   回退 head，再回退第一个可见成员；全部不可见时返回 null；
 * - 面板渲染全部成员：用户隐藏的成员以 display:none 保持挂载（快捷键仍可用），
 *   运行时不可见的成员（插件未就绪等）不渲染；
 * - 成员被点击时通过 onMemberClick 记录最后使用。
 */
export const ToolbarGroupSlot: React.FC<{
	headKey: ToolbarToolKey;
	/** 组合全部成员（不含 head，未过滤） */
	members: ToolbarToolKey[];
	hiddenSet: Set<ToolbarToolKey>;
	/** 运行时可见性（插件等条件），用于过滤成员与主按钮回退 */
	isToolVisible: (key: ToolbarToolKey) => boolean;
	/** 该组合最后使用的成员键（来自 Cache） */
	lastUsedKey?: ToolbarToolKey;
	/** 成员被点击（记录最后使用） */
	onMemberClick?: (key: ToolbarToolKey) => void;
	/** 渲染单个工具按钮（与普通槽位共用同一渲染函数） */
	renderTool: (key: ToolbarToolKey) => React.ReactNode;
}> = ({
	headKey,
	members,
	hiddenSet,
	isToolVisible,
	lastUsedKey,
	onMemberClick,
	renderTool,
}) => {
	const { token } = theme.useToken();

	const allKeys = useMemo(() => [headKey, ...members], [headKey, members]);

	/** 可作为主按钮的键：未被用户隐藏且运行时可见 */
	const usableKeys = useMemo(
		() => allKeys.filter((key) => !hiddenSet.has(key) && isToolVisible(key)),
		[allKeys, hiddenSet, isToolVisible],
	);

	const mainKey = useMemo(() => {
		if (lastUsedKey && usableKeys.includes(lastUsedKey)) {
			return lastUsedKey;
		}
		if (usableKeys.includes(headKey)) {
			return headKey;
		}
		return usableKeys[0];
	}, [headKey, lastUsedKey, usableKeys]);

	if (!mainKey) {
		return null;
	}

	return (
		<ToolbarPopover
			trigger={usableKeys.length > 1 ? "hover" : []}
			content={
				<Flex align="center" gap={token.paddingXS} className="popover-toolbar">
					{allKeys.map((key) =>
						isToolVisible(key) ? (
							<div
								key={key}
								style={{
									display: hiddenSet.has(key) ? "none" : undefined,
								}}
								onClickCapture={() => {
									onMemberClick?.(key);
								}}
							>
								{renderTool(key)}
							</div>
						) : null,
					)}
				</Flex>
			}
		>
			<div
				onClickCapture={() => {
					onMemberClick?.(mainKey);
				}}
			>
				{renderTool(mainKey)}
			</div>
		</ToolbarPopover>
	);
};
