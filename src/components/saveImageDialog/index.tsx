import {
	FolderOpenOutlined,
	LockOutlined,
	PlusOutlined,
	UndoOutlined,
	UnlockOutlined,
} from "@ant-design/icons";
import { desktopDir, join as joinPath } from "@tauri-apps/api/path";
import * as dialog from "@tauri-apps/plugin-dialog";
import {
	Button,
	Flex,
	Input,
	InputNumber,
	Modal,
	Segmented,
	Select,
	Slider,
	Spin,
	theme,
} from "antd";
import {
	type ChangeEvent,
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { useHotkeysContext } from "react-hotkeys-hook";
import { FormattedMessage, useIntl } from "react-intl";
import { saveFile } from "@/commands";
import { AntdContext } from "@/contexts/antdContext";
import {
	AppSettingsActionContext,
	AppSettingsPublisher,
} from "@/contexts/appSettingsActionContext";
import { useStateRef } from "@/hooks/useStateRef";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import {
	CaptureEvent,
	type CaptureEventParams,
	CaptureEventPublisher,
} from "@/pages/draw/extra";
import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import { HotkeysScope } from "@/types/core/appHotKeys";
import { ImageFormat, type ImagePath } from "@/types/utils/file";
import { appError } from "@/utils/log";
import { generateImageFileName, getImageSaveDirectory, joinImagePath } from "@/utils/file";

export type SaveImageDialogShowParams = {
	/** 待保存的图像 */
	image: HTMLCanvasElement;
	/** 上一次使用的图像格式，作为默认选中项 */
	prevImageFormat?: ImageFormat;
};

export type SaveImageDialogActionType = {
	show: (
		params: SaveImageDialogShowParams,
	) => Promise<ImagePath | undefined>;
	isOpen: () => boolean;
};

type ResizeMode = "pixel" | "percent";

const MIN_SIZE = 1;
const MAX_SIZE = 16384;

const clampSize = (value: number) => {
	return Math.min(Math.max(Math.round(value), MIN_SIZE), MAX_SIZE);
};

/** 将画布按目标尺寸编码为指定格式的 Blob */
const encodeCanvas = (
	canvas: HTMLCanvasElement,
	width: number,
	height: number,
	format: ImageFormat,
	quality: number,
): Promise<Blob | undefined> => {
	return new Promise((resolve) => {
		let target = canvas;
		if (width !== canvas.width || height !== canvas.height) {
			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = width;
			tempCanvas.height = height;
			const ctx = tempCanvas.getContext("2d");
			if (!ctx) {
				resolve(undefined);
				return;
			}
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = "high";
			ctx.drawImage(canvas, 0, 0, width, height);
			target = tempCanvas;
		}

		let blobType: string = format;
		if (
			format === ImageFormat.AVIF ||
			format === ImageFormat.JPEG_XL
		) {
			blobType = "image/webp";
		}

		target.toBlob(
			(blob) => {
				resolve(blob ?? undefined);
			},
			blobType,
			quality / 100,
		);
	});
};

const formatFileSize = (size: number) => {
	if (size < 1024) {
		return `${size} B`;
	}
	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(2)} KB`;
	}
	return `${(size / 1024 / 1024).toFixed(2)} MB`;
};

const IMAGE_FORMAT_OPTIONS = [
	{ label: ".PNG", value: ImageFormat.PNG },
	{ label: ".JPG", value: ImageFormat.JPEG },
	{ label: ".WEBP", value: ImageFormat.WEBP },
	{ label: ".AVIF", value: ImageFormat.AVIF },
	{ label: ".JXL", value: ImageFormat.JPEG_XL },
];

const FILE_NAME_INVALID_CHARS = /[\\/:*?"<>|]/g;


export const SaveImageDialog: React.FC<{
	actionRef: React.RefObject<SaveImageDialogActionType | undefined>;
}> = ({ actionRef }) => {
	const { token } = theme.useToken();
	const intl = useIntl();
	const { message } = useContext(AntdContext);
	const { updateAppSettings } = useContext(AppSettingsActionContext);
	const { disableScope, enableScope } = useHotkeysContext();

	const [open, setOpen, openRef] = useStateRef<boolean>(false);
	const [saving, setSaving, savingRef] = useStateRef<boolean>(false);

	const imageRef = useRef<HTMLCanvasElement | undefined>(undefined);
	const resolveRef = useRef<
		((imagePath: ImagePath | undefined) => void) | undefined
	>(undefined);
	const aspectRatioRef = useRef<number>(1);
	const encodedUrlRef = useRef<string | undefined>(undefined);
	const originalUrlRef = useRef<string | undefined>(undefined);

	const [originalUrl, setOriginalUrl] = useState<string | undefined>(
		undefined,
	);
	const [originalSize, setOriginalSize] = useState<{
		width: number;
		height: number;
	}>({ width: 0, height: 0 });
	const [encodedUrl, setEncodedUrl] = useState<string | undefined>(undefined);
	const [estimatedSize, setEstimatedSize] = useState<number | undefined>(
		undefined,
	);
	const [encoding, setEncoding] = useState<boolean>(false);

	const [saveDir, setSaveDir] = useState<string>("");
	const [fileName, setFileName] = useState<string>("");
	const [imageFormat, setImageFormat] = useState<ImageFormat>(
		ImageFormat.PNG,
	);
	const [resizeMode, setResizeMode] = useState<ResizeMode>("pixel");
	const [width, setWidth] = useState<number>(0);
	const [height, setHeight] = useState<number>(0);
	const [percent, setPercent] = useState<number>(100);
	const [lockAspectRatio, setLockAspectRatio, lockAspectRatioRef] =
		useStateRef<boolean>(true);
	const [quality, setQuality] = useState<number>(90);
	const [previewTab, setPreviewTab] = useState<"original" | "encoded">(
		"original",
	);
	const [quickDirList, setQuickDirList] = useState<
		{ label: string; path: string }[]
	>([]);

	const [appSettings] = useStateSubscriber(AppSettingsPublisher, undefined);

	const previewImgRef = useRef<HTMLImageElement | null>(null);
	const [zoomPercent, setZoomPercent] = useState<number>(100);

	const closeDialog = useCallback(() => {
		if (encodedUrlRef.current) {
			URL.revokeObjectURL(encodedUrlRef.current);
			encodedUrlRef.current = undefined;
		}
		if (originalUrlRef.current) {
			URL.revokeObjectURL(originalUrlRef.current);
			originalUrlRef.current = undefined;
		}
		setEncodedUrl(undefined);
		setOriginalUrl(undefined);
		setEstimatedSize(undefined);
		setPreviewTab("original");
		setOpen(false);
	}, [setOpen]);

	const handleCancel = useCallback(() => {
		if (savingRef.current) {
			return;
		}
		resolveRef.current?.(undefined);
		closeDialog();
	}, [closeDialog, savingRef]);

	useImperativeHandle(
		actionRef,
		() => {
			return {
				isOpen: () => openRef.current,
				show: async (params: SaveImageDialogShowParams) => {
					if (openRef.current) {
						return undefined;
					}

					const canvas = params.image;
					imageRef.current = canvas;
					aspectRatioRef.current =
						canvas.height / Math.max(canvas.width, 1);
					setOriginalSize({
						width: canvas.width,
						height: canvas.height,
					});

					const appSettingsData = appSettings();
					const screenshotSettings =
						appSettingsData[AppSettingsGroup.FunctionScreenshot];
					const outputSettings =
						appSettingsData[AppSettingsGroup.FunctionOutput];

					const initialFormat =
						params.prevImageFormat ??
						screenshotSettings.saveFileFormat ??
						ImageFormat.PNG;
					setImageFormat(initialFormat);

					const initialPercent = clampSize(
						Math.round(screenshotSettings.saveFileResizePercent || 100),
					);
					setPercent(initialPercent);
					setWidth(clampSize((canvas.width * initialPercent) / 100));
					setHeight(clampSize((canvas.height * initialPercent) / 100));
					setResizeMode(initialPercent === 100 ? "pixel" : "percent");
					setLockAspectRatio(true);
					setPreviewTab("original");
					setEncoding(false);
					setSaving(false);

					const initialFileName = generateImageFileName(
						outputSettings.manualSaveFileNameFormat,
					);
					setFileName(initialFileName);

					const defaultDirectory =
						await getImageSaveDirectory(appSettingsData);
					setSaveDir(defaultDirectory);

					const quickDirs = [
						{
							label: intl.formatMessage({
								id: "draw.saveImageDialog.quickAccess.defaultDirectory",
							}),
							path: defaultDirectory,
						},
					];
					try {
						quickDirs.push({
							label: intl.formatMessage({
								id: "draw.saveImageDialog.quickAccess.desktop",
							}),
							path: await desktopDir(),
						});
					} catch (error) {
						appError("[SaveImageDialog] desktopDir error", error);
					}
					setQuickDirList(quickDirs);

					// 生成原图预览
					canvas.toBlob((blob) => {
						if (!blob) {
							return;
						}
						const url = URL.createObjectURL(blob);
						originalUrlRef.current = url;
						setOriginalUrl(url);
					}, "image/png");

					const promise = new Promise<ImagePath | undefined>((resolve) => {
						resolveRef.current = resolve;
					});
					setOpen(true);
					return promise;
				},
			};
		},
		[
			appSettings,
			intl,
			openRef,
			setLockAspectRatio,
			setOpen,
			savingRef,
		],
	);

	// 弹窗打开期间禁用绘图快捷键
	useEffect(() => {
		if (open) {
			disableScope(HotkeysScope.DrawTool);
		} else {
			enableScope(HotkeysScope.DrawTool);
		}

		return () => {
			enableScope(HotkeysScope.DrawTool);
		};
	}, [open, disableScope, enableScope]);

	// 弹窗打开期间拦截右键，避免右键退出画布时弹窗残留、画布被误关闭
	useEffect(() => {
		if (!open) {
			return;
		}

		const handleContextMenu = (event: MouseEvent) => {
			event.stopPropagation();
			event.preventDefault();
		};
		document.addEventListener("contextmenu", handleContextMenu, true);

		return () => {
			document.removeEventListener("contextmenu", handleContextMenu, true);
		};
	}, [open]);

	// 截图生命周期结束时关闭弹窗，避免状态残留到下一次截图
	useStateSubscriber(
		CaptureEventPublisher,
		useCallback(
			(params: CaptureEventParams | undefined) => {
				if (savingRef.current) {
					return;
				}
				if (
					params?.event === CaptureEvent.onCaptureFinish ||
					params?.event === CaptureEvent.onCaptureReady
				) {
					closeDialog();
				}
			},
			[closeDialog, savingRef],
		),
	);

	// 参数变化后重新编码，估算文件大小
	useEffect(() => {
		if (!open || !imageRef.current) {
			return;
		}

		let cancelled = false;
		const timer = setTimeout(async () => {
			setEncoding(true);
			try {
				const blob = await encodeCanvas(
					imageRef.current as HTMLCanvasElement,
					width,
					height,
					imageFormat,
					quality,
				);
				if (cancelled || !blob) {
					return;
				}
				const url = URL.createObjectURL(blob);
				if (encodedUrlRef.current) {
					URL.revokeObjectURL(encodedUrlRef.current);
				}
				encodedUrlRef.current = url;
				setEncodedUrl(url);
				setEstimatedSize(blob.size);
			} finally {
				if (!cancelled) {
					setEncoding(false);
				}
			}
		}, 250);

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open, width, height, imageFormat, quality]);

	const updateZoomPercent = useCallback(() => {
		const img = previewImgRef.current;
		if (!img || !img.clientWidth || !img.naturalWidth) {
			return;
		}
		setZoomPercent(
			Math.max(1, Math.round((img.clientWidth / img.naturalWidth) * 100)),
		);
	}, []);

	const onWidthChange = useCallback(
		(value: number | null) => {
			if (value === null || Number.isNaN(value)) {
				return;
			}
			const newWidth = clampSize(value);
			if (lockAspectRatioRef.current) {
				setHeight(clampSize(newWidth * aspectRatioRef.current));
			}
			setWidth(newWidth);
		},
		[lockAspectRatioRef, setHeight, setWidth],
	);

	const onHeightChange = useCallback(
		(value: number | null) => {
			if (value === null || Number.isNaN(value)) {
				return;
			}
			const newHeight = clampSize(value);
			if (lockAspectRatioRef.current) {
				setWidth(clampSize(newHeight / Math.max(aspectRatioRef.current, Number.EPSILON)));
			}
			setHeight(newHeight);
		},
		[lockAspectRatioRef, setHeight, setWidth],
	);

	const onPercentChange = useCallback(
		(value: number | null) => {
			if (value === null || Number.isNaN(value)) {
				return;
			}
			const newPercent = Math.min(Math.max(Math.round(value), 1), 1000);
			setPercent(newPercent);
			setWidth(
				clampSize(((originalSize.width ?? 0) * newPercent) / 100),
			);
			setHeight(
				clampSize(((originalSize.height ?? 0) * newPercent) / 100),
			);
		},
		[originalSize.height, originalSize.width, setHeight, setPercent, setWidth],
	);

	const onResetSize = useCallback(() => {
		setPercent(100);
		setWidth(originalSize.width);
		setHeight(originalSize.height);
	}, [originalSize.height, originalSize.width, setHeight, setPercent, setWidth]);

	const onResizeModeChange = useCallback(
		(mode: ResizeMode) => {
			if (mode === resizeMode) {
				return;
			}
			if (mode === "percent") {
				setPercent(
					Math.min(
						Math.max(
							Math.round((width / Math.max(originalSize.width, 1)) * 100),
							1,
						),
						1000,
					),
				);
			}
			setResizeMode(mode);
		},
		[originalSize.width, resizeMode, setPercent, setWidth, width],
	);

	const onPickDirectory = useCallback(async () => {
		const dirPath = await dialog.open({
			directory: true,
			defaultPath: saveDir,
		});
		if (dirPath) {
			setSaveDir(dirPath);
		}
	}, [saveDir, setSaveDir]);

	const onFileNameChange = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			setFileName(event.target.value);
		},
		[setFileName],
	);

	const handleSave = useCallback(async () => {
		const canvas = imageRef.current;
		if (!canvas || savingRef.current) {
			return;
		}

		const sanitizedFileName = fileName
			.trim()
			.replace(FILE_NAME_INVALID_CHARS, "-")
			.replace(/^\.+/, "")
			.replace(/[\s.]+$/, "");
		if (!sanitizedFileName) {
			message.error(
				<FormattedMessage id="draw.saveImageDialog.fileNameInvalid" />,
			);
			return;
		}

		setSaving(true);
		try {
			const blob = await encodeCanvas(
				canvas,
				width,
				height,
				imageFormat,
				quality,
			);
			if (!blob) {
				message.error(
					<FormattedMessage id="draw.saveImageDialog.saveFailed" />,
				);
				return;
			}

			const filePath = joinImagePath(
				await joinPath(saveDir, sanitizedFileName),
				imageFormat,
			);
			await saveFile(filePath, await blob.arrayBuffer(), imageFormat);

			const screenshotSettings = appSettings()[
				AppSettingsGroup.FunctionScreenshot
			];
			if (screenshotSettings.saveFileResizePercent !== percent) {
				updateAppSettings(
					AppSettingsGroup.FunctionScreenshot,
					{
						saveFileResizePercent: percent,
					},
					false,
					true,
					false,
					true,
					false,
				);
			}

			resolveRef.current?.({ filePath, imageFormat });
			closeDialog();
		} catch (error) {
			appError("[SaveImageDialog] save file error", error);
			message.error(
				<FormattedMessage id="draw.saveImageDialog.saveFailed" />,
			);
		} finally {
			setSaving(false);
		}
	}, [
		appSettings,
		closeDialog,
		fileName,
		height,
		imageFormat,
		message,
		percent,
		quality,
		saveDir,
		savingRef,
		setSaving,
		updateAppSettings,
		width,
	]);

	const labelStyle: React.CSSProperties = {
		fontSize: token.fontSizeSM,
		color: token.colorTextSecondary,
	};

	const previewAreaStyle: React.CSSProperties = {
		height: 460,
		borderRadius: token.borderRadiusLG,
		backgroundColor: token.colorFillQuaternary,
		backgroundImage: `radial-gradient(${token.colorFill} 1px, transparent 1px)`,
		backgroundSize: "12px 12px",
		overflow: "hidden",
	};

	const showQualitySlider = imageFormat !== ImageFormat.PNG;
	const previewUrl = previewTab === "encoded" ? encodedUrl : originalUrl;

	return (
		<Modal
			title={<FormattedMessage id="draw.saveImageDialog.title" />}
			open={open}
			onCancel={handleCancel}
			footer={null}
			width={880}
			centered
			maskClosable={false}
			destroyOnHidden
		>
			<Flex gap={token.marginLG} align="stretch">
				{/* 预览区域 */}
				<Flex
					vertical
					gap={token.marginSM}
					style={{ flex: "1 1 auto", minWidth: 0 }}
				>
					<div style={{ textAlign: "center" }}>
						<Segmented
							value={previewTab}
							onChange={(value) => {
								setPreviewTab(value as "original" | "encoded");
							}}
							options={[
								{
									label: (
										<FormattedMessage id="draw.saveImageDialog.tab.original" />
									),
									value: "original",
								},
								{
									label: (
										<FormattedMessage id="draw.saveImageDialog.tab.encoded" />
									),
									value: "encoded",
								},
							]}
						/>
					</div>

					<Flex
						align="center"
						justify="center"
						style={previewAreaStyle}
					>
						{previewUrl ? (
							<img
								ref={previewImgRef}
								src={previewUrl}
								alt="preview"
								onLoad={updateZoomPercent}
								style={{
									maxWidth: "100%",
									maxHeight: "100%",
									objectFit: "contain",
								}}
							/>
						) : (
							<Spin />
						)}
					</Flex>

					<Flex justify="space-between" style={labelStyle}>
						<span>
							<FormattedMessage id="draw.saveImageDialog.zoom" />
							: {zoomPercent}%
						</span>
						<span>
							<FormattedMessage id="draw.saveImageDialog.originalSize" />
							: {originalSize.width} x {originalSize.height}
						</span>
					</Flex>
				</Flex>

				{/* 参数区域 */}
				<Flex
					vertical
					gap={token.marginXS}
					style={{ flex: "0 0 300px" }}
				>
					<div style={labelStyle}>
						<FormattedMessage id="draw.saveImageDialog.savePath" />
					</div>
					<Flex gap={token.marginXS}>
						<Input
							readOnly
							value={saveDir}
							title={saveDir}
							onChange={(event) => {
								setSaveDir(event.target.value);
							}}
						/>
						<Button onClick={onPickDirectory}>
							<FormattedMessage id="draw.saveImageDialog.change" />
						</Button>
					</Flex>
					<Flex gap={token.marginXS} wrap="wrap">
						{quickDirList.map((quickDir) => (
							<Button
								key={quickDir.path}
								size="small"
								type={
									saveDir === quickDir.path ? "primary" : "default"
								}
								icon={<FolderOpenOutlined />}
								title={quickDir.path}
								onClick={() => {
									setSaveDir(quickDir.path);
								}}
							>
								{quickDir.label}
							</Button>
						))}
						<Button
							size="small"
							icon={<PlusOutlined />}
							title={intl.formatMessage({
								id: "draw.saveImageDialog.quickAccess.add",
							})}
							onClick={onPickDirectory}
						/>
					</Flex>

					<div style={{ ...labelStyle, marginTop: token.marginSM }}>
						<FormattedMessage id="draw.saveImageDialog.fileName" />
					</div>
					<Flex gap={token.marginXS}>
						<Input
							value={fileName}
							onChange={onFileNameChange}
							style={{ flex: "1 1 auto", minWidth: 0 }}
						/>
						<Select
							value={imageFormat}
							onChange={(value) => {
								setImageFormat(value);
							}}
							options={IMAGE_FORMAT_OPTIONS}
							style={{ flex: "0 0 96px" }}
						/>
					</Flex>

					<Flex
						align="center"
						justify="space-between"
						style={{ marginTop: token.marginSM }}
					>
						<span style={labelStyle}>
							<FormattedMessage id="draw.saveImageDialog.resize" />
						</span>
						<Segmented
							size="small"
							value={resizeMode}
							onChange={(value) => {
								onResizeModeChange(value as ResizeMode);
							}}
							options={[
								{
									label: (
										<FormattedMessage id="draw.saveImageDialog.resizeMode.pixel" />
									),
									value: "pixel",
								},
								{
									label: (
										<FormattedMessage id="draw.saveImageDialog.resizeMode.percent" />
									),
									value: "percent",
								},
							]}
						/>
					</Flex>

					{resizeMode === "pixel" ? (
						<Flex gap={token.marginXS} align="center">
							<InputNumber
								value={width}
								min={MIN_SIZE}
								max={MAX_SIZE}
								precision={0}
								suffix="W"
								onChange={onWidthChange}
								style={{ flex: "1 1 0", minWidth: 0 }}
							/>
							<Button
								type={lockAspectRatio ? "primary" : "default"}
								icon={
									lockAspectRatio ? (
										<LockOutlined />
									) : (
										<UnlockOutlined />
									)
								}
								title={intl.formatMessage({
									id: "draw.saveImageDialog.lockAspectRatio",
								})}
								onClick={() => {
									setLockAspectRatio(!lockAspectRatio);
								}}
							/>
							<InputNumber
								value={height}
								min={MIN_SIZE}
								max={MAX_SIZE}
								precision={0}
								suffix="H"
								onChange={onHeightChange}
								style={{ flex: "1 1 0", minWidth: 0 }}
							/>
							<Button
								icon={<UndoOutlined />}
								title={intl.formatMessage({
									id: "draw.saveImageDialog.resetSize",
								})}
								onClick={onResetSize}
							/>
						</Flex>
					) : (
						<Flex gap={token.marginXS} align="center">
							<InputNumber
								value={percent}
								min={1}
								max={1000}
								precision={0}
								suffix="%"
								onChange={onPercentChange}
								style={{ flex: "1 1 auto", minWidth: 0 }}
							/>
							<Button
								icon={<UndoOutlined />}
								title={intl.formatMessage({
									id: "draw.saveImageDialog.resetSize",
								})}
								onClick={onResetSize}
							/>
						</Flex>
					)}

					{showQualitySlider ? (
						<>
							<div style={{ ...labelStyle, marginTop: token.marginXS }}>
								<FormattedMessage id="draw.saveImageDialog.quality" />
								: {quality}
							</div>
							<Slider
								min={1}
								max={100}
								value={quality}
								onChange={(value) => {
									setQuality(value as number);
								}}
							/>
						</>
					) : (
						<div style={{ ...labelStyle, marginTop: token.marginXS }}>
							{intl.formatMessage(
								{ id: "draw.saveImageDialog.qualityDisabledTip" },
								{ format: imageFormat.split("/")[1]?.toUpperCase() },
							)}
						</div>
					)}

					<div style={{ ...labelStyle, marginTop: token.marginSM }}>
						<FormattedMessage id="draw.saveImageDialog.estimatedSize" />
					</div>
					<div style={{ minHeight: 24 }}>
						{encoding || estimatedSize === undefined ? (
							<Spin size="small" />
						) : (
							<strong>{formatFileSize(estimatedSize)}</strong>
						)}
					</div>

					<Button
						type="primary"
						size="large"
						loading={saving}
						style={{ marginTop: token.marginSM }}
						onClick={handleSave}
					>
						<FormattedMessage id="draw.saveImageDialog.save" />
					</Button>
				</Flex>
			</Flex>
		</Modal>
	);
};
