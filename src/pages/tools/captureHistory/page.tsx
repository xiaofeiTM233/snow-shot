"use client";

import { DeleteOutlined, ReloadOutlined } from "@ant-design/icons";
import { type ActionType, ProList } from "@ant-design/pro-components";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button, Popconfirm, Space, Tag, theme } from "antd";
import dayjs from "dayjs";
import type { Key } from "react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { EventListenerContext } from "@/components/eventListener";
import { AppSettingsPublisher } from "@/contexts/appSettingsActionContext";
import { executeScreenshot } from "@/functions/screenshot";
import { useAppSettingsLoad } from "@/hooks/useAppSettingsLoad";
import { useStateRef } from "@/hooks/useStateRef";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import type { AppSettingsData } from "@/types/appSettings";
import {
	type CaptureHistoryItem,
	CaptureHistorySource,
} from "@/utils/appStore";
import {
	CaptureHistory,
	getCaptureHistoryImageAbsPath,
} from "@/utils/captureHistory";
import { appWarn } from "@/utils/log";
import { ScreenshotType } from "@/utils/types";
import { CaptureHistoryItemActions } from "./components/captureHistoryItemActions";
import { CaptureHistoryItemPreview } from "./components/captureHistoryItemPreview";
import type { CaptureHistoryRecordItem } from "./extra";

export const CaptureHistoryPage = () => {
	const intl = useIntl();
	const [loading, setLoading] = useState(true);
	const [dataSource, setDataSource, dataSourceRef] = useStateRef<
		CaptureHistoryItem[] | undefined
	>(undefined);
	const captureHistoryRef = useRef<CaptureHistory | undefined>(undefined);
	const { token } = theme.useToken();
	const actionRef = useRef<ActionType>(null);

	const initedRef = useRef(false);
	const [getAppSettings] = useStateSubscriber(AppSettingsPublisher, undefined);
	const initDataSource = useCallback(
		async (appSettings: AppSettingsData) => {
			if (initedRef.current) {
				return;
			}
			initedRef.current = true;

			setLoading(true);

			captureHistoryRef.current = new CaptureHistory();
			await captureHistoryRef.current.init();
			const list = (await captureHistoryRef.current.getList(appSettings)).sort(
				(a, b) => b.create_ts - a.create_ts,
			);
			setDataSource(list);

			actionRef.current?.reload();
		},
		[setDataSource],
	);
	const reloadList = useCallback(async () => {
		initedRef.current = false;
		initDataSource(getAppSettings());
	}, [getAppSettings, initDataSource]);

	useAppSettingsLoad(initDataSource, false);

	const { addListener, removeListener } = useContext(EventListenerContext);
	useEffect(() => {
		const listenerId = addListener("on-capture-history-change", () => {
			reloadList();
		});
		return () => {
			removeListener(listenerId);
		};
	}, [addListener, reloadList, removeListener]);

	const getSourceDesc = useCallback(
		(source: CaptureHistorySource | undefined) => {
			switch (source) {
				case CaptureHistorySource.ScrollScreenshotCopy:
					return (
						<FormattedMessage id="tools.captureHistory.source.scrollScreenshotCopy" />
					);
				case CaptureHistorySource.ScrollScreenshotSave:
					return (
						<FormattedMessage id="tools.captureHistory.source.scrollScreenshotSave" />
					);
				case CaptureHistorySource.ScrollScreenshotFixed:
					return (
						<FormattedMessage id="tools.captureHistory.source.scrollScreenshotFixed" />
					);
				case CaptureHistorySource.Copy:
					return <FormattedMessage id="tools.captureHistory.source.copy" />;
				case CaptureHistorySource.Save:
					return <FormattedMessage id="tools.captureHistory.source.save" />;
				case CaptureHistorySource.Fixed:
					return <FormattedMessage id="tools.captureHistory.source.fixed" />;
				case CaptureHistorySource.FullScreen:
					return (
						<FormattedMessage id="tools.captureHistory.source.fullScreen" />
					);
			}

			return <FormattedMessage id="tools.captureHistory.source.unknown" />;
		},
		[],
	);

	const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);

	const currentFilterDataRef = useRef<CaptureHistoryRecordItem[]>([]);
	const tableAlertOptionRender = useCallback(() => {
		return (
			<Space>
				<Popconfirm
					title={
						<FormattedMessage id="tools.captureHistory.deleteSelected.confirm" />
					}
					onConfirm={async () => {
						await Promise.all(
							selectedRowKeys.map((key) => {
								if (typeof key !== "string") {
									appWarn(
										"[CaptureHistoryPage] selectedRowKeys is not a string",
										key,
									);
									return Promise.resolve();
								}

								return captureHistoryRef.current?.delete(key);
							}),
						);

						reloadList();
						setSelectedRowKeys([]);
					}}
				>
					<a key="delete" style={{ color: token.colorError }}>
						<FormattedMessage id="tools.captureHistory.delete" />
					</a>
				</Popconfirm>
				<a
					key="selectAll"
					onClick={() =>
						setSelectedRowKeys((prev) => {
							const set = new Set(prev);
							currentFilterDataRef.current.forEach((item) => {
								set.add(item.id);
							});
							return Array.from(set);
						})
					}
				>
					<FormattedMessage id="tools.captureHistory.selectAll" />
				</a>
				<a key="clearSelection" onClick={() => setSelectedRowKeys([])}>
					<FormattedMessage id="tools.captureHistory.clearSelection" />
				</a>
			</Space>
		);
	}, [selectedRowKeys, token, reloadList]);

	return (
		<>
			<ProList<CaptureHistoryRecordItem>
				rowSelection={{
					selectedRowKeys,
					onChange: (keys: Key[]) => setSelectedRowKeys(keys),
					preserveSelectedRowKeys: true,
					hideSelectAll: false,
				}}
				tableAlertOptionRender={tableAlertOptionRender}
				itemLayout="vertical"
				split
				cardProps={{
					styles: {
						body: { paddingInline: 0, paddingBlock: 0 },
					},
				}}
				rowKey="id"
				headerTitle={
					<>
						<FormattedMessage id="tools.captureHistory.count" />
						{`: ${dataSource?.length ?? "-"}`}
					</>
				}
				loading={loading}
				className="capture-history-list"
				actionRef={actionRef}
				toolBarRender={() => [
					<div key="clearAll">
						<Popconfirm
							key="clearAll"
							title={
								<FormattedMessage id="tools.captureHistory.clearAll.confirm" />
							}
							onConfirm={async () => {
								await captureHistoryRef.current?.clearAll();
								reloadList();
							}}
						>
							<Button
								type="text"
								icon={<DeleteOutlined />}
								style={{ color: token.colorError }}
								title={intl.formatMessage({
									id: "tools.captureHistory.clearAll",
								})}
							/>
						</Popconfirm>
					</div>,
					<Button
						key="reload"
						type="text"
						loading={loading}
						onClick={() => {
							reloadList();
						}}
						icon={<ReloadOutlined />}
					/>,
				]}
				request={async (params) => {
					setLoading(true);

					if (!dataSourceRef.current) {
						currentFilterDataRef.current = [];
						return {
							data: [],
							success: false,
							pageSize: 10,
							total: 0,
						};
					}

					const pageSize = params.pageSize ?? 10;
					const current = params.current ?? 1;
					const startIndex = (current - 1) * pageSize;

					let startTs: number | undefined;
					let endTs: number | undefined;
					if (
						"create_ts" in params &&
						Array.isArray(params.create_ts) &&
						params.create_ts.length === 2
					) {
						startTs = dayjs(
							params.create_ts[0],
							"YYYY-MM-DD HH:mm:ss",
						).valueOf();
						endTs = dayjs(params.create_ts[1], "YYYY-MM-DD HH:mm:ss").valueOf();
					}

					const filterData = dataSourceRef.current.filter((item) => {
						let isMatch = true;
						if (startTs && endTs) {
							isMatch &&= item.create_ts >= startTs && item.create_ts <= endTs;
						}
						if (params.source) {
							isMatch &&= item.source === params.source;
						}
						return isMatch;
					});
					const data = await Promise.all(
						filterData
							.slice(startIndex, startIndex + pageSize)
							.map(async (item, index) => {
								const file_path = await getCaptureHistoryImageAbsPath(
									item.file_name,
								);
								const capture_result_file_path = item.capture_result_file_name
									? await getCaptureHistoryImageAbsPath(
											item.capture_result_file_name,
										)
									: undefined;
								return {
									...item,
									serial_number: startIndex + index + 1,
									file_path,
									file_url: convertFileSrc(file_path),
									capture_result_file_path,
									capture_result_file_url: capture_result_file_path
										? convertFileSrc(capture_result_file_path)
										: undefined,
								};
							}),
					);

					setLoading(false);

					currentFilterDataRef.current = data;
					return {
						data,
						success: true,
						pageSize: pageSize,
						total: filterData.length,
					};
				}}
				pagination={{
					defaultPageSize: 20,
					showSizeChanger: true,
				}}
				search={{
					filterType: "light",
				}}
				metas={{
					source: {
						search: true,
						dataIndex: "source",
						valueType: "select",
						title: <FormattedMessage id="tools.captureHistory.source" />,
						valueEnum: {
							[CaptureHistorySource.Copy]: (
								<FormattedMessage id="tools.captureHistory.source.copy" />
							),
							[CaptureHistorySource.Save]: (
								<FormattedMessage id="tools.captureHistory.source.save" />
							),
							[CaptureHistorySource.Fixed]: (
								<FormattedMessage id="tools.captureHistory.source.fixed" />
							),
							[CaptureHistorySource.FullScreen]: (
								<FormattedMessage id="tools.captureHistory.source.fullScreen" />
							),
							[CaptureHistorySource.ScrollScreenshotCopy]: (
								<FormattedMessage id="tools.captureHistory.source.scrollScreenshotCopy" />
							),
							[CaptureHistorySource.ScrollScreenshotSave]: (
								<FormattedMessage id="tools.captureHistory.source.scrollScreenshotSave" />
							),
							[CaptureHistorySource.ScrollScreenshotFixed]: (
								<FormattedMessage id="tools.captureHistory.source.scrollScreenshotFixed" />
							),
						},
					},
					title: {
						title: <FormattedMessage id="tools.captureHistory.date" />,
						render: (_, item) => {
							return (
								<div
									onClick={() => {
										executeScreenshot(
											ScreenshotType.SwitchCaptureHistory,
											undefined,
											item.id,
										);
									}}
								>
									{`${item.serial_number}. `}
									<FormattedMessage id="tools.captureHistory.date" />
									{`: ${dayjs(item.create_ts).format("YYYY-MM-DD HH:mm:ss")}`}
								</div>
							);
						},
						search: true,
						dataIndex: "create_ts",
						valueType: "dateTimeRange",
					},
					description: {
						search: false,
						render: (_, item) => {
							const { selected_rect } = item;

							return (
								<Space wrap gap={[token.marginXS, 0]}>
									<Tag>
										<FormattedMessage id="tools.captureHistory.position" />
										{`: ${selected_rect.min_x} , ${selected_rect.min_y}`}
									</Tag>
									<Tag>
										<FormattedMessage id="tools.captureHistory.size" />
										{`: ${selected_rect.max_x - selected_rect.min_x} x ${selected_rect.max_y - selected_rect.min_y}`}
									</Tag>
									<Tag>
										<FormattedMessage id="tools.captureHistory.drawElements" />
										{`: ${item.excalidraw_elements?.length ?? 0}`}
									</Tag>
									<Tag>
										<FormattedMessage id="tools.captureHistory.source" />
										{`: `}
										{getSourceDesc(item.source)}
									</Tag>
								</Space>
							);
						},
					},
					actions: {
						search: false,
						cardActionProps: "extra",
						render: (_, item: CaptureHistoryRecordItem) => {
							return (
								<CaptureHistoryItemActions
									item={item}
									reloadList={reloadList}
									captureHistoryRef={captureHistoryRef}
								/>
							);
						},
					},
					extra: {
						search: false,
						render: (_: unknown, item: CaptureHistoryRecordItem) => {
							return <CaptureHistoryItemPreview item={item} />;
						},
					},
				}}
			/>
			<style jsx>
				{`
				:global(.ant-pro-list.ant-pro-list-vertical .ant-pro-list-row-header) {
    			flex-direction: row;
				}
			`}
			</style>
		</>
	);
};
