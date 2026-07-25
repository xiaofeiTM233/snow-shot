"use client";

import { ArrowDownOutlined, ArrowUpOutlined, CopyOutlined, DeleteOutlined, PlusOutlined, SaveOutlined, ToTopOutlined, VerticalAlignBottomOutlined } from "@ant-design/icons";
import { Button, Checkbox, ColorPicker, Divider, Empty, Flex, InputNumber, Segmented, Select, Slider, Space, Tooltip, Typography, theme } from "antd";
import type { AggregationColor } from "antd/es/color-picker/color";
import type * as React from "react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ContentWrap } from "@/components/contentWrap";
import { AntdContext } from "@/contexts/antdContext";
import { AppSettingsPublisher } from "@/contexts/appSettingsActionContext";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { saveFile } from "@/commands";
import { showImageDialog } from "@/utils/file";
import { writeImageToClipboard } from "@/utils/clipboard";
import { ImageFormat } from "@/types/utils/file";

interface CollageItem {
	id: string;
	src: string;
	name: string;
	naturalWidth: number;
	naturalHeight: number;
	// 自由拼接模式下的变换信息
	x: number;
	y: number;
	width: number;
	height: number;
	z: number;
}

type CollageMode = "long" | "free";

const OUTPUT_FORMAT_OPTIONS = [
	{ label: "PNG", value: ImageFormat.PNG },
	{ label: "JPEG", value: ImageFormat.JPEG },
	{ label: "WebP", value: ImageFormat.WEBP },
];

const loadImage = (src: string) =>
	new Promise<HTMLImageElement>((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});

const getImageSize = (src: string) =>
	new Promise<{ w: number; h: number }>((resolve) => {
		const img = new Image();
		img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
		img.onerror = () => resolve({ w: 0, h: 0 });
		img.src = src;
	});

const canvasToBlob = (canvas: HTMLCanvasElement, mime: string) =>
	new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));

const CollageCore = () => {
	const { token } = theme.useToken();
	const intl = useIntl();
	const { message } = useContext(AntdContext);
	const [getAppSettings] = useStateSubscriber(AppSettingsPublisher, undefined);

	const [mode, setMode] = useState<CollageMode>("long");
	const [items, setItems] = useState<CollageItem[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	// 长图拼接设置
	const [direction, setDirection] = useState<"vertical" | "horizontal">("vertical");
	const [gap, setGap] = useState(0);
	const [unifySize, setUnifySize] = useState(false);

	// 通用背景设置
	const [backgroundColor, setBackgroundColor] = useState<string>("#ffffff");
	const [transparentBg, setTransparentBg] = useState(false);

	// 自由拼接设置
	const [canvasWidth, setCanvasWidth] = useState(1000);
	const [canvasHeight, setCanvasHeight] = useState(800);

	const [outputFormat, setOutputFormat] = useState<ImageFormat>(ImageFormat.PNG);
	const [exporting, setExporting] = useState(false);

	const idCounter = useRef(0);
	const maxZ = useRef(0);
	const itemsRef = useRef(items);
	const fileInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		itemsRef.current = items;
	});
	useEffect(() => {
		const urls = itemsRef.current.map((it) => it.src);
		return () => {
			urls.forEach((url) => URL.revokeObjectURL(url));
		};
		// 仅在卸载时执行清理
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const addImages = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const onFileInputChange = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const files = e.target.files;
			if (!files || files.length === 0) {
				return;
			}
			const count = itemsRef.current.length;
			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				const url = URL.createObjectURL(file);
				const size = await getImageSize(url);
				const name = file.name || `image-${i + 1}`;

				let width = size.w;
				let height = size.h;
				// 自由模式下新图片缩放到合适尺寸并错落摆放
				if (mode === "free") {
					const maxDim = 320;
					if (width > maxDim) {
						const ratio = maxDim / width;
						width = Math.round(width * ratio);
						height = Math.round(height * ratio);
					}
				}

				const item: CollageItem = {
					id: `collage-${idCounter.current++}`,
					src: url,
					name,
					naturalWidth: size.w,
					naturalHeight: size.h,
					x: 40 + (count + i) * 24,
					y: 40 + (count + i) * 24,
					width: Math.round(width),
					height: Math.round(height),
					z: maxZ.current++,
				};
				setItems((prev) => [...prev, item]);
			}
			setSelectedId(null);
			e.target.value = "";
		},
		[mode],
	);

	const removeItem = useCallback((id: string) => {
		setItems((prev) => {
			const target = prev.find((it) => it.id === id);
			if (target) {
				URL.revokeObjectURL(target.src);
			}
			return prev.filter((it) => it.id !== id);
		});
		setSelectedId((prev) => (prev === id ? null : prev));
	}, []);

	const moveItem = useCallback((id: string, step: number) => {
		setItems((prev) => {
			const index = prev.findIndex((it) => it.id === id);
			if (index < 0) {
				return prev;
			}
			const target = index + step;
			if (target < 0 || target >= prev.length) {
				return prev;
			}
			const next = [...prev];
			const [item] = next.splice(index, 1);
			next.splice(target, 0, item);
			return next;
		});
	}, []);

	const bringToFront = useCallback((id: string) => {
		setItems((prev) =>
			prev.map((it) =>
				it.id === id ? { ...it, z: maxZ.current++ } : it,
			),
		);
	}, []);

	const sendToBack = useCallback((id: string) => {
		setItems((prev) => {
			const minZ = prev.reduce(
				(min, it) => Math.min(min, it.z),
				Number.MAX_SAFE_INTEGER,
			);
			return prev.map((it) =>
				it.id === id ? { ...it, z: minZ - 1 } : it,
			);
		});
	}, []);

	const buildCanvas = useCallback(async (): Promise<HTMLCanvasElement | null> => {
		if (itemsRef.current.length === 0) {
			return null;
		}
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return null;
		}

		const fillBackground = (w: number, h: number) => {
			if (transparentBg) {
				if (outputFormat === ImageFormat.JPEG) {
					ctx.fillStyle = "#ffffff";
					ctx.fillRect(0, 0, w, h);
				}
				return;
			}
			ctx.fillStyle = backgroundColor;
			ctx.fillRect(0, 0, w, h);
		};

		if (mode === "long") {
			const list = itemsRef.current;
			const vertical = direction === "vertical";
			const sizes = list.map((it) => {
				if (!unifySize) {
					return { w: it.naturalWidth, h: it.naturalHeight };
				}
				if (vertical) {
					const w = list[0].naturalWidth;
					const h = it.naturalHeight * (w / it.naturalWidth);
					return { w, h };
				}
				const h = list[0].naturalHeight;
				const w = it.naturalWidth * (h / it.naturalHeight);
				return { w, h };
			});

			if (vertical) {
				canvas.width = unifySize
					? list[0].naturalWidth
					: Math.max(...sizes.map((s) => s.w));
				canvas.height =
					sizes.reduce((acc, s) => acc + s.h, 0) + gap * (sizes.length - 1);
			} else {
				canvas.height = unifySize
					? list[0].naturalHeight
					: Math.max(...sizes.map((s) => s.h));
				canvas.width =
					sizes.reduce((acc, s) => acc + s.w, 0) + gap * (sizes.length - 1);
			}

			fillBackground(canvas.width, canvas.height);

			let offset = 0;
			for (let i = 0; i < list.length; i++) {
				const img = await loadImage(list[i].src);
				const s = sizes[i];
				if (vertical) {
					ctx.drawImage(img, 0, offset, s.w, s.h);
					offset += s.h + gap;
				} else {
					ctx.drawImage(img, offset, 0, s.w, s.h);
					offset += s.w + gap;
				}
			}
		} else {
			canvas.width = canvasWidth;
			canvas.height = canvasHeight;
			fillBackground(canvas.width, canvas.height);
			const sorted = [...itemsRef.current].sort((a, b) => a.z - b.z);
			for (const it of sorted) {
				const img = await loadImage(it.src);
				ctx.drawImage(img, it.x, it.y, it.width, it.height);
			}
		}

		return canvas;
	}, [
		mode,
		direction,
		gap,
		unifySize,
		transparentBg,
		backgroundColor,
		outputFormat,
		canvasWidth,
		canvasHeight,
	]);

	const onSave = useCallback(async () => {
		if (itemsRef.current.length === 0) {
			message.warning(intl.formatMessage({ id: "tools.collage.noImages" }));
			return;
		}
		setExporting(true);
		try {
			const canvas = await buildCanvas();
			if (!canvas) {
				return;
			}
			const imagePath = await showImageDialog(getAppSettings(), outputFormat);
			if (!imagePath) {
				return;
			}
			const blob = await canvasToBlob(canvas, imagePath.imageFormat);
			if (!blob) {
				message.error(intl.formatMessage({ id: "tools.collage.saveFailed" }));
				return;
			}
			await saveFile(
				imagePath.filePath,
				await blob.arrayBuffer(),
				imagePath.imageFormat,
			);
			message.success(intl.formatMessage({ id: "tools.collage.saveSuccess" }));
		} catch (error) {
			console.error("[Collage] save failed", error);
			message.error(intl.formatMessage({ id: "tools.collage.saveFailed" }));
		} finally {
			setExporting(false);
		}
	}, [buildCanvas, getAppSettings, intl, message, outputFormat]);

	const onCopy = useCallback(async () => {
		if (itemsRef.current.length === 0) {
			message.warning(intl.formatMessage({ id: "tools.collage.noImages" }));
			return;
		}
		setExporting(true);
		try {
			const canvas = await buildCanvas();
			if (!canvas) {
				return;
			}
			const blob = await canvasToBlob(canvas, outputFormat);
			if (!blob) {
				message.error(intl.formatMessage({ id: "tools.collage.saveFailed" }));
				return;
			}
			await writeImageToClipboard(blob, outputFormat);
			message.success(intl.formatMessage({ id: "tools.collage.copySuccess" }));
		} catch (error) {
			console.error("[Collage] copy failed", error);
			message.error(intl.formatMessage({ id: "tools.collage.saveFailed" }));
		} finally {
			setExporting(false);
		}
	}, [buildCanvas, intl, message, outputFormat]);

	const renderImageList = () => {
		if (items.length === 0) {
			return (
				<Empty
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description={intl.formatMessage({ id: "tools.collage.noImages" })}
				/>
			);
		}
		return (
			<div className="collage-image-list">
				{items.map((it, index) => (
					<div
						key={it.id}
						className={`collage-image-item ${
							selectedId === it.id ? "is-selected" : ""
						}`}
						onClick={() => mode === "free" && setSelectedId(it.id)}
					>
						<img src={it.src} alt={it.name} />
						<div className="collage-image-item-mask">
							<Typography.Text ellipsis style={{ maxWidth: 120, color: "#fff" }}>
								{it.name}
							</Typography.Text>
							<Space size={2}>
								<Tooltip title={intl.formatMessage({ id: "tools.collage.moveUp" })}>
									<Button
										type="text"
										size="small"
										icon={<ArrowUpOutlined />}
										disabled={index === 0}
										onClick={(e) => {
											e.stopPropagation();
											moveItem(it.id, -1);
										}}
									/>
								</Tooltip>
								<Tooltip
									title={intl.formatMessage({ id: "tools.collage.moveDown" })}
								>
									<Button
										type="text"
										size="small"
										icon={<ArrowDownOutlined />}
										disabled={index === items.length - 1}
										onClick={(e) => {
											e.stopPropagation();
											moveItem(it.id, 1);
										}}
									/>
								</Tooltip>
								{mode === "free" && (
									<>
										<Tooltip
											title={intl.formatMessage({
												id: "tools.collage.bringToFront",
											})}
										>
											<Button
												type="text"
												size="small"
												icon={<ToTopOutlined />}
												onClick={(e) => {
													e.stopPropagation();
													bringToFront(it.id);
													setSelectedId(it.id);
												}}
											/>
										</Tooltip>
										<Tooltip
											title={intl.formatMessage({
												id: "tools.collage.sendToBack",
											})}
										>
											<Button
												type="text"
												size="small"
												icon={<VerticalAlignBottomOutlined />}
												onClick={(e) => {
													e.stopPropagation();
													sendToBack(it.id);
												}}
											/>
										</Tooltip>
									</>
								)}
								<Tooltip title={intl.formatMessage({ id: "tools.collage.remove" })}>
									<Button
										type="text"
										size="small"
										danger
										icon={<DeleteOutlined />}
										onClick={(e) => {
											e.stopPropagation();
											removeItem(it.id);
										}}
									/>
								</Tooltip>
							</Space>
						</div>
					</div>
				))}
			</div>
		);
	};

	const renderLongPreview = () => {
		const list = items;
		const vertical = direction === "vertical";
		const base = unifySize ? list[0]?.naturalWidth : 0;
		const bg = transparentBg
			? "checkerboard"
			: backgroundColor;
		return (
			<div className="collage-long-preview-wrap">
				<div
					className="collage-long-preview"
					style={{
						flexDirection: vertical ? "column" : "row",
						gap: gap,
						background: bg === "checkerboard" ? undefined : bg,
					}}
				>
					{list.map((it) => (
						<img
							key={it.id}
							src={it.src}
							style={{
								width: unifySize
									? vertical
										? base
										: undefined
									: undefined,
								height: unifySize && !vertical ? list[0]?.naturalHeight : undefined,
								display: "block",
							}}
						/>
					))}
				</div>
			</div>
		);
	};

	const handleItemPointerDown = (e: React.PointerEvent, id: string) => {
		e.preventDefault();
		const item = items.find((it) => it.id === id);
		if (!item) {
			return;
		}
		setSelectedId(id);
		bringToFront(id);
		const startX = e.clientX;
		const startY = e.clientY;
		const origX = item.x;
		const origY = item.y;
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const onMove = (ev: PointerEvent) => {
			const dx = ev.clientX - startX;
			const dy = ev.clientY - startY;
			setItems((prev) =>
				prev.map((it) =>
					it.id === id ? { ...it, x: origX + dx, y: origY + dy } : it,
				),
			);
		};
		const onUp = (ev: PointerEvent) => {
			el.releasePointerCapture(ev.pointerId);
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerup", onUp);
		};
		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerup", onUp);
	};

	const handleResizePointerDown = (e: React.PointerEvent, id: string) => {
		e.preventDefault();
		e.stopPropagation();
		const item = items.find((it) => it.id === id);
		if (!item) {
			return;
		}
		const startX = e.clientX;
		const startY = e.clientY;
		const origW = item.width;
		const origH = item.height;
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const onMove = (ev: PointerEvent) => {
			const dx = ev.clientX - startX;
			const dy = ev.clientY - startY;
			const w = Math.max(20, origW + dx);
			const h = Math.max(20, origH + dy);
			setItems((prev) =>
				prev.map((it) =>
					it.id === id ? { ...it, width: w, height: h } : it,
				),
			);
		};
		const onUp = (ev: PointerEvent) => {
			el.releasePointerCapture(ev.pointerId);
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerup", onUp);
		};
		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerup", onUp);
	};

	const renderFreeCanvas = () => {
		const bg = transparentBg ? "checkerboard" : backgroundColor;
		return (
			<div className="collage-free-wrap">
				<div
					className="collage-free-canvas"
					style={{
						width: canvasWidth,
						height: canvasHeight,
						background: bg === "checkerboard" ? undefined : bg,
					}}
				>
					{items.map((it) => (
						<div
							key={it.id}
							className={`collage-free-item ${
								selectedId === it.id ? "is-selected" : ""
							}`}
							style={{
								left: it.x,
								top: it.y,
								width: it.width,
								height: it.height,
								zIndex: it.z,
							}}
							onPointerDown={(e) => handleItemPointerDown(e, it.id)}
						>
							<img src={it.src} draggable={false} alt={it.name} />
							{selectedId === it.id && (
								<div
									className="collage-free-resize"
									onPointerDown={(e) => handleResizePointerDown(e, it.id)}
								/>
							)}
						</div>
					))}
				</div>
			</div>
		);
	};

	return (
		<ContentWrap className="collage-wrap">
			<div className="collage-toolbar">
				<Segmented
					value={mode}
					onChange={(value) => setMode(value as CollageMode)}
					options={[
						{
							label: intl.formatMessage({ id: "tools.collage.longMode" }),
							value: "long",
						},
						{
							label: intl.formatMessage({ id: "tools.collage.freeMode" }),
							value: "free",
						},
					]}
				/>
			<Space>
				<Button icon={<PlusOutlined />} onClick={addImages}>
					<FormattedMessage id="tools.collage.addImages" />
				</Button>
				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					multiple
					style={{ display: "none" }}
					onChange={onFileInputChange}
				/>
					<Typography.Text>
						<FormattedMessage id="tools.collage.outputFormat" />
					</Typography.Text>
					<Select
						value={outputFormat}
						onChange={(value) => setOutputFormat(value)}
						options={OUTPUT_FORMAT_OPTIONS}
						style={{ width: 100 }}
					/>
					<Button icon={<CopyOutlined />} onClick={onCopy} disabled={exporting}>
						<FormattedMessage id="tools.collage.copyToClipboard" />
					</Button>
					<Button
						type="primary"
						icon={<SaveOutlined />}
						onClick={onSave}
						loading={exporting}
					>
						<FormattedMessage id="tools.collage.saveToFile" />
					</Button>
				</Space>
			</div>

			<div className="collage-body">
				<div className="collage-side">
					<Flex vertical gap={token.paddingXS}>
						<Typography.Text strong>
							<FormattedMessage id="tools.collage.background" />
						</Typography.Text>
						<Space>
							<ColorPicker
								value={backgroundColor}
								disabled={transparentBg}
								onChange={(color: AggregationColor) =>
									setBackgroundColor(color.toRgbString())
								}
								showText
							/>
							<Checkbox
								checked={transparentBg}
								onChange={(e) => setTransparentBg(e.target.checked)}
							>
								<FormattedMessage id="tools.collage.transparentBackground" />
							</Checkbox>
						</Space>
					</Flex>

					{mode === "long" ? (
						<Flex vertical gap={token.paddingXS} style={{ marginTop: token.margin }}>
							<Typography.Text strong>
								<FormattedMessage id="tools.collage.layout" />
							</Typography.Text>
							<Segmented
								value={direction}
								onChange={(value) =>
									setDirection(value as "vertical" | "horizontal")
								}
								options={[
									{
										label: intl.formatMessage({
											id: "tools.collage.direction.vertical",
										}),
										value: "vertical",
									},
									{
										label: intl.formatMessage({
											id: "tools.collage.direction.horizontal",
										}),
										value: "horizontal",
									},
								]}
							/>
							<div className="collage-slider-row">
								<Typography.Text>
									<FormattedMessage id="tools.collage.gap" />
								</Typography.Text>
								<Slider
									min={0}
									max={100}
									value={gap}
									onChange={(value) => setGap(value)}
									style={{ width: 160 }}
								/>
								<Typography.Text>{gap}px</Typography.Text>
							</div>
							<Tooltip
								title={intl.formatMessage({ id: "tools.collage.unifySize.tip" })}
							>
								<Checkbox
									checked={unifySize}
									onChange={(e) => setUnifySize(e.target.checked)}
								>
									<FormattedMessage id="tools.collage.unifySize" />
								</Checkbox>
							</Tooltip>
						</Flex>
					) : (
						<Flex vertical gap={token.paddingXS} style={{ marginTop: token.margin }}>
							<Typography.Text strong>
								<FormattedMessage id="tools.collage.canvasSize" />
							</Typography.Text>
							<Space>
								<Typography.Text>
									<FormattedMessage id="tools.collage.width" />
								</Typography.Text>
								<InputNumber
									min={1}
									max={20000}
									value={canvasWidth}
									onChange={(value) =>
										setCanvasWidth(value ?? canvasWidth)
									}
									style={{ width: 100 }}
								/>
								<Typography.Text>
									<FormattedMessage id="tools.collage.height" />
								</Typography.Text>
								<InputNumber
									min={1}
									max={20000}
									value={canvasHeight}
									onChange={(value) =>
										setCanvasHeight(value ?? canvasHeight)
									}
									style={{ width: 100 }}
								/>
							</Space>
							<Typography.Text type="secondary" style={{ fontSize: 12 }}>
								<FormattedMessage id="tools.collage.freeTip" />
							</Typography.Text>
						</Flex>
					)}

					<Divider style={{ margin: `${token.marginSM}px 0` }} />
					<Typography.Text strong>
						<FormattedMessage id="tools.collage.imageList" />
					</Typography.Text>
					{renderImageList()}
				</div>

				<div className="collage-main">
					{items.length === 0 ? (
						<div className="collage-empty">
							<Empty
								description={intl.formatMessage({
									id: "tools.collage.noImages",
								})}
							/>
						</div>
					) : mode === "long" ? (
						renderLongPreview()
					) : (
						renderFreeCanvas()
					)}
				</div>
			</div>

			<style jsx>{`
                :global(.collage-wrap) {
                    display: flex;
                    flex-direction: column;
                }

                .collage-toolbar {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    flex-wrap: wrap;
                    gap: ${token.paddingXS}px;
                    padding: ${token.paddingSM}px ${token.padding}px;
                    border-bottom: 1px solid ${token.colorBorderSecondary};
                }

                .collage-body {
                    flex: 1;
                    display: flex;
                    min-height: 0;
                }

                .collage-side {
                    width: 280px;
                    flex-shrink: 0;
                    padding: ${token.padding}px;
                    border-right: 1px solid ${token.colorBorderSecondary};
                    overflow: auto;
                }

                .collage-main {
                    flex: 1;
                    min-width: 0;
                    overflow: auto;
                    display: flex;
                    padding: ${token.padding}px;
                }

                .collage-empty {
                    margin: auto;
                }

                .collage-slider-row {
                    display: flex;
                    align-items: center;
                    gap: ${token.paddingXS}px;
                }

                .collage-image-list {
                    display: flex;
                    flex-direction: column;
                    gap: ${token.paddingXS}px;
                    margin-top: ${token.paddingXS}px;
                }

                :global(.collage-image-item) {
                    position: relative;
                    border-radius: ${token.borderRadius}px;
                    overflow: hidden;
                    border: 2px solid transparent;
                    cursor: ${mode === "free" ? "pointer" : "default"};
                }

                :global(.collage-image-item.is-selected) {
                    border-color: ${token.colorPrimary};
                }

                :global(.collage-image-item) img {
                    width: 100%;
                    height: 90px;
                    object-fit: cover;
                    display: block;
                }

                :global(.collage-image-item-mask) {
                    position: absolute;
                    inset: 0;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: space-between;
                    padding: 4px;
                    background: rgba(0, 0, 0, 0.35);
                    opacity: 0;
                    transition: opacity 0.15s;
                }

                :global(.collage-image-item:hover .collage-image-item-mask) {
                    opacity: 1;
                }

                .collage-long-preview-wrap {
                    margin: auto;
                    max-width: 100%;
                    overflow: auto;
                }

                :global(.collage-long-preview) {
                    display: flex;
                    width: max-content;
                    max-width: 100%;
                    background-color: #fff;
                    background-image: linear-gradient(
                            45deg,
                            #cccccc 25%,
                            transparent 25%
                        ),
                        linear-gradient(-45deg, #cccccc 25%, transparent 25%),
                        linear-gradient(45deg, transparent 75%, #cccccc 75%),
                        linear-gradient(-45deg, transparent 75%, #cccccc 75%);
                    background-size: 16px 16px;
                    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
                }

                :global(.collage-long-preview) img {
                    display: block;
                }

                .collage-free-wrap {
                    margin: auto;
                }

                :global(.collage-free-canvas) {
                    position: relative;
                    background-color: #fff;
                    background-image: linear-gradient(
                            45deg,
                            #cccccc 25%,
                            transparent 25%
                        ),
                        linear-gradient(-45deg, #cccccc 25%, transparent 25%),
                        linear-gradient(45deg, transparent 75%, #cccccc 75%),
                        linear-gradient(-45deg, transparent 75%, #cccccc 75%);
                    background-size: 16px 16px;
                    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
                    box-shadow: 0 0 8px rgba(0, 0, 0, 0.15);
                }

                :global(.collage-free-item) {
                    position: absolute;
                    box-sizing: border-box;
                    cursor: move;
                    user-select: none;
                    touch-action: none;
                }

                :global(.collage-free-item.is-selected) {
                    outline: 2px solid ${token.colorPrimary};
                    outline-offset: 0;
                }

                :global(.collage-free-item) img {
                    width: 100%;
                    height: 100%;
                    object-fit: fill;
                    pointer-events: none;
                    display: block;
                }

                :global(.collage-free-resize) {
                    position: absolute;
                    right: 0;
                    bottom: 0;
                    width: 14px;
                    height: 14px;
                    background: ${token.colorPrimary};
                    cursor: nwse-resize;
                    border-radius: 2px 0 0 0;
                }
            `}</style>
		</ContentWrap>
	);
};

export const CollagePage = () => {
	return <CollageCore />;
};
