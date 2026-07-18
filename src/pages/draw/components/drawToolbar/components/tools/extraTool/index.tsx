import { ScanOutlined } from "@ant-design/icons";
import { Button, Flex, theme } from "antd";
import { useCallback, useContext, useState } from "react";
import { useIntl } from "react-intl";
import { createVideoRecordWindow } from "@/commands/core";
import { DrawStatePublisher } from "@/components/drawCore/extra";
import { VideoRecordIcon } from "@/components/icons";
import { PLUGIN_ID_FFMPEG } from "@/constants/pluginService";
import {
	AppSettingsActionContext,
	AppSettingsPublisher,
} from "@/contexts/appSettingsActionContext";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { AntdContext } from "@/contexts/antdContext";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { DrawContext } from "@/pages/draw/types";
import {
	type AppSettingsData,
	AppSettingsGroup,
	ExtraToolList,
} from "@/types/appSettings";
import { DrawState } from "@/types/draw";
import { getPlatform } from "@/utils/platform";
import { getButtonTypeByState } from "../../../extra";
import { ToolbarPopover } from "../../toolbarPopover";

export const ExtraTool: React.FC<{
	onToolClickAction: (tool: DrawState) => void;
	disable: boolean;
}> = ({ onToolClickAction, disable }) => {
	const intl = useIntl();
	const { message } = useContext(AntdContext);
	const { token } = theme.useToken();

	const { updateAppSettings } = useContext(AppSettingsActionContext);
	const { captureBoundingBoxInfoRef, selectLayerActionRef, finishCapture } =
		useContext(DrawContext);

	const [lastActiveTool, setLastActiveTool] = useState<ExtraToolList>(
		ExtraToolList.None,
	);
	useStateSubscriber(
		AppSettingsPublisher,
		useCallback((settings: AppSettingsData) => {
			setLastActiveTool(settings[AppSettingsGroup.Cache].lastExtraTool);
		}, []),
	);

	const [activeTool, setActiveTool] = useState<ExtraToolList>(
		ExtraToolList.None,
	);
	const [, setEnabled] = useState(false);

	const executeScanQrcode = useCallback(() => {
		setActiveTool(ExtraToolList.ScanQrcode);
	}, []);

	const executeVideoRecord = useCallback(() => {
		const captureBoundingBoxInfo = captureBoundingBoxInfoRef.current;
		const selectRect = selectLayerActionRef.current?.getSelectRect();
		if (!captureBoundingBoxInfo || !selectRect) {
			return;
		}

		const monitorRect = captureBoundingBoxInfo.transformWindowRect(selectRect);

		if (
			getPlatform() === "macos" &&
			captureBoundingBoxInfo.getActiveMonitorRectList(monitorRect).length > 1
		) {
			message.warning(
				intl.formatMessage({
					id: "draw.extraTool.videoRecord.multiMonitor",
				}),
			);
			return;
		}

		createVideoRecordWindow(
			monitorRect.min_x,
			monitorRect.min_y,
			monitorRect.max_x,
			monitorRect.max_y,
		);

		// 快捷执行时立刻 finish 可能窗口很多数据还没初始化好，所以延迟执行
		setTimeout(() => {
			finishCapture();
		}, 0);
	}, [captureBoundingBoxInfoRef, finishCapture, intl, selectLayerActionRef]);

	const updateLastActiveTool = useCallback(
		(value: ExtraToolList) => {
			updateAppSettings(
				AppSettingsGroup.Cache,
				{ lastExtraTool: value },
				true,
				true,
				false,
				true,
				false,
			);
		},
		[updateAppSettings],
	);

	useStateSubscriber(
		DrawStatePublisher,
		useCallback(
			(drawState: DrawState) => {
				if (
					drawState === DrawState.ExtraTools ||
					drawState === DrawState.ScanQrcode ||
					drawState === DrawState.VideoRecord
				) {
					if (drawState === DrawState.ScanQrcode) {
						executeScanQrcode();
						updateLastActiveTool(ExtraToolList.ScanQrcode);
					} else if (drawState === DrawState.VideoRecord) {
						executeVideoRecord();
						updateLastActiveTool(ExtraToolList.VideoRecord);
					}

					setEnabled(true);
				} else {
					setActiveTool(ExtraToolList.None);
					setEnabled(false);
				}
			},
			[executeScanQrcode, executeVideoRecord, updateLastActiveTool],
		),
	);

	const scanQrcodeButton = (
		<Button
			icon={<ScanOutlined />}
			title={intl.formatMessage({ id: "draw.extraTool.scanQrcode" })}
			type={getButtonTypeByState(activeTool === ExtraToolList.ScanQrcode)}
			key="scanQrcode"
			onClick={() => {
				onToolClickAction(DrawState.ScanQrcode);
			}}
			disabled={disable}
		/>
	);

	const videoRecordButton = (
		<Button
			icon={<VideoRecordIcon />}
			title={intl.formatMessage({ id: "draw.extraTool.videoRecord" })}
			type={getButtonTypeByState(activeTool === ExtraToolList.VideoRecord)}
			key="videoRecord"
			onClick={() => {
				onToolClickAction(DrawState.VideoRecord);
			}}
			disabled={disable}
		/>
	);

	const { isReadyStatus } = usePluginServiceContext();

	let mainToolbarButton = isReadyStatus?.(PLUGIN_ID_FFMPEG)
		? videoRecordButton
		: scanQrcodeButton;

	if (lastActiveTool === ExtraToolList.ScanQrcode) {
		mainToolbarButton = scanQrcodeButton;
	} else if (
		lastActiveTool === ExtraToolList.VideoRecord &&
		isReadyStatus?.(PLUGIN_ID_FFMPEG)
	) {
		mainToolbarButton = videoRecordButton;
	}

	return (
		<ToolbarPopover
			trigger={isReadyStatus?.(PLUGIN_ID_FFMPEG) ? "hover" : []}
			content={
				<Flex align="center" gap={token.paddingXS} className="popover-toolbar">
					{scanQrcodeButton}

					{isReadyStatus?.(PLUGIN_ID_FFMPEG) && videoRecordButton}
				</Flex>
			}
		>
			<div>{mainToolbarButton}</div>
		</ToolbarPopover>
	);
};
