import { FixedIcon } from "@/components/icons";
import { CopyOutlined, DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { Button, Popconfirm, Space } from "antd";
import { useCallback, useState } from "react";
import { FormattedMessage } from "react-intl";
import { executeScreenshot } from "@/functions/screenshot";
import { createFixedContentWindow } from "@/commands/core";
import type { CaptureHistory } from "@/utils/captureHistory";
import { writeFilePathToClipboard } from "@/utils/clipboard";
import { ScreenshotType } from "@/utils/types";
import type { CaptureHistoryRecordItem } from "../extra";

export const CaptureHistoryItemActions: React.FC<{
	item: CaptureHistoryRecordItem;
	reloadList: () => Promise<void>;
	captureHistoryRef: React.RefObject<CaptureHistory | undefined>;
	// 当前预览展示的图片路径，贴图时优先使用该路径
	pinImagePath?: string;
}> = ({ item, reloadList, captureHistoryRef, pinImagePath }) => {
	const [editLoading, setEditLoading] = useState(false);
	const [copyLoading, setCopyLoading] = useState(false);
	const [deleteLoading, setDeleteLoading] = useState(false);
	const [fixedLoading, setFixedLoading] = useState(false);
	const deleteAction = useCallback(async () => {
		if (!(await captureHistoryRef.current?.inited())) {
			return;
		}
		await captureHistoryRef.current?.delete(item.id);
		await reloadList();
	}, [captureHistoryRef, item.id, reloadList]);

	const fixedAction = useCallback(async () => {
		if (!pinImagePath) {
			return;
		}

		setFixedLoading(true);
		try {
			await createFixedContentWindow(false, pinImagePath);
		} catch (error) {
			console.error("[CaptureHistoryItemActions] 贴图失败", error);
		} finally {
			setFixedLoading(false);
		}
	}, [pinImagePath]);

	return (
		<Space wrap style={{ width: "100%" }}>
			<Button
				key="view"
				onClick={async () => {
					setEditLoading(true);
					await executeScreenshot(
						ScreenshotType.SwitchCaptureHistory,
						undefined,
						item.id,
					);
					setEditLoading(false);
				}}
				size="small"
				color="primary"
				variant="link"
				icon={<EditOutlined />}
				loading={editLoading}
			>
				<FormattedMessage id="tools.captureHistory.switch" />
			</Button>
			<Button
				onClick={async () => {
					if (!item.capture_result_file_path) {
						return;
					}

					setCopyLoading(true);
					await writeFilePathToClipboard(item.capture_result_file_path);
					setCopyLoading(false);
				}}
				key="copy"
				size="small"
				color="primary"
				variant="link"
				icon={<CopyOutlined />}
				loading={copyLoading}
			>
				<FormattedMessage id="tools.captureHistory.copy" />
			</Button>
			<Button
				onClick={fixedAction}
				key="fixed"
				size="small"
				color="primary"
				variant="link"
				icon={<FixedIcon />}
				loading={fixedLoading}
			>
				<FormattedMessage id="tools.captureHistory.fixed" />
			</Button>
			<Popconfirm
				key="delete"
				title={<FormattedMessage id="tools.captureHistory.delete.confirm" />}
				onConfirm={async () => {
					setDeleteLoading(true);
					await deleteAction();
					setDeleteLoading(false);
				}}
				okButtonProps={{
					loading: deleteLoading,
				}}
			>
				<Button
					color="danger"
					size="small"
					variant="link"
					icon={<DeleteOutlined />}
				>
					<FormattedMessage id="tools.captureHistory.delete" />
				</Button>
			</Popconfirm>
		</Space>
	);
};
