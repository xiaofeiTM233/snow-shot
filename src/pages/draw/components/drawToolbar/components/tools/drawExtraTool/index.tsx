"use client";

import { Button, Flex, theme } from "antd";
import { useCallback, useContext, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { DrawStatePublisher } from "@/components/drawCore/extra";
import { HighlightIcon, WatermarkIcon } from "@/components/icons";
import {
	AppSettingsActionContext,
	AppSettingsPublisher,
} from "@/contexts/appSettingsActionContext";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { ToolbarPopover } from "@/pages/draw/components/drawToolbar/components/toolbarPopover";
import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import { DrawState } from "@/types/draw";
import { getButtonTypeByState } from "../../../extra";
import { WatermarkTool } from "./components/watermarkTool";

export const DrawExtraTool: React.FC<{
	customToolbarToolHiddenMap: Partial<Record<DrawState, boolean>> | undefined;
	onToolClickAction: (tool: DrawState) => void;
	disable: boolean;
}> = ({ customToolbarToolHiddenMap, onToolClickAction, disable }) => {
	const intl = useIntl();
	const { token } = theme.useToken();

	const { updateAppSettings } = useContext(AppSettingsActionContext);

	const [lastDrawExtraTool, setLastDrawExtraTool] = useState<DrawState>(
		DrawState.Idle,
	);
	useStateSubscriber(
		AppSettingsPublisher,
		useCallback((settings: AppSettingsData) => {
			setLastDrawExtraTool(settings[AppSettingsGroup.Cache].lastDrawExtraTool);
		}, []),
	);
	const [drawState, setDrawState] = useState(DrawState.Idle);
	useStateSubscriber(
		DrawStatePublisher,
		useCallback((state: DrawState) => {
			setDrawState(state);
		}, []),
	);

	const updateLastDrawExtraTool = useCallback(
		(value: DrawState) => {
			updateAppSettings(
				AppSettingsGroup.Cache,
				{ lastDrawExtraTool: value },
				true,
				true,
				false,
				true,
				false,
			);
		},
		[updateAppSettings],
	);

	const watermarkButton = useMemo(() => {
		return (
			<Button
				icon={<WatermarkIcon />}
				title={intl.formatMessage({ id: "draw.watermarkTool" })}
				type={getButtonTypeByState(drawState === DrawState.Watermark)}
				key="watermark"
				onClick={() => {
					onToolClickAction(DrawState.Watermark);
					updateLastDrawExtraTool(DrawState.Watermark);
				}}
				disabled={disable}
			/>
		);
	}, [disable, drawState, intl, onToolClickAction, updateLastDrawExtraTool]);

	const highlightButton = useMemo(() => {
		return (
			<Button
				icon={<HighlightIcon />}
				title={intl.formatMessage({ id: "draw.highlightTool" })}
				type={getButtonTypeByState(drawState === DrawState.Highlight)}
				key="highlight"
				onClick={() => {
					onToolClickAction(DrawState.Highlight);
					updateLastDrawExtraTool(DrawState.Highlight);
				}}
				disabled={disable}
			/>
		);
	}, [disable, drawState, intl, onToolClickAction, updateLastDrawExtraTool]);

	// 未记录过选择（Idle）时默认展示高亮；若高亮被隐藏则回落到水印，若水印被隐藏则回落到高亮
	let mainToolbarButton = customToolbarToolHiddenMap?.[DrawState.Watermark]
		? highlightButton
		: customToolbarToolHiddenMap?.[DrawState.Highlight]
			? watermarkButton
			: highlightButton;
	if (
		lastDrawExtraTool === DrawState.Watermark &&
		!customToolbarToolHiddenMap?.[DrawState.Watermark]
	) {
		mainToolbarButton = watermarkButton;
	} else if (
		lastDrawExtraTool === DrawState.Highlight &&
		!customToolbarToolHiddenMap?.[DrawState.Highlight]
	) {
		mainToolbarButton = highlightButton;
	}

	if (
		customToolbarToolHiddenMap?.[DrawState.Watermark] &&
		customToolbarToolHiddenMap?.[DrawState.Highlight]
	) {
		return null;
	}

	return (
		<>
			<ToolbarPopover
				trigger={
					!customToolbarToolHiddenMap?.[DrawState.Watermark] &&
					!customToolbarToolHiddenMap?.[DrawState.Highlight]
						? "hover"
						: []
				}
				content={
					<Flex
						align="center"
						gap={token.paddingXS}
						className="popover-toolbar"
					>
						{!customToolbarToolHiddenMap?.[DrawState.Watermark] &&
							watermarkButton}
						{!customToolbarToolHiddenMap?.[DrawState.Highlight] &&
							highlightButton}
					</Flex>
				}
			>
				<div>{mainToolbarButton}</div>
			</ToolbarPopover>

			<WatermarkTool />
		</>
	);
};
