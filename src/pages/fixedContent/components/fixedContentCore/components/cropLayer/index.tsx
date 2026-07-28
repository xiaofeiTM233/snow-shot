import {
	CheckOutlined,
	CloseOutlined,
	ReloadOutlined,
} from "@ant-design/icons";
import { Button, theme } from "antd";
import React, {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { updateElementPosition } from "@/pages/draw/components/drawToolbar/components/dragButton/extra";
import { MousePosition } from "@/utils/mousePosition";
import { zIndexs } from "@/utils/zIndex";
import type { ElementRect } from "@/types/commands/screenshot";

export type CropLayerProps = {
	/** 当前内容的快照（画布坐标系分辨率，即画布原始像素） */
	sourceCanvas: HTMLCanvasElement;
	/** 画布坐标系尺寸 */
	canvasSize: { width: number; height: number };
	/** 显示尺寸（CSS 像素），仅作为首帧参考，实际尺寸由容器自适应测量 */
	displaySize?: { width: number; height: number };
	onConfirm: (cropRect: ElementRect) => void;
	onCancel: () => void;
};

type DragMode =
	| "create"
	| "move"
	| "nw"
	| "n"
	| "ne"
	| "e"
	| "se"
	| "s"
	| "sw"
	| "w";

const HANDLE_LIST: {
	mode: DragMode;
	edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean };
}[] = [
	{ mode: "nw", edges: { left: true, top: true } },
	{ mode: "n", edges: { top: true } },
	{ mode: "ne", edges: { right: true, top: true } },
	{ mode: "e", edges: { right: true } },
	{ mode: "se", edges: { right: true, bottom: true } },
	{ mode: "s", edges: { bottom: true } },
	{ mode: "sw", edges: { left: true, bottom: true } },
	{ mode: "w", edges: { left: true } },
];

const clamp = (value: number, min: number, max: number) => {
	return Math.min(Math.max(value, min), max);
};

const isRectValid = (rect: ElementRect) =>
	rect.max_x - rect.min_x > 1 && rect.max_y - rect.min_y > 1;

export const CropLayer: React.FC<CropLayerProps> = ({
	sourceCanvas,
	canvasSize,
	displaySize,
	onConfirm,
	onCancel,
}) => {
	const { token } = theme.useToken();
	const intl = useIntl();

	const containerRef = useRef<HTMLDivElement>(null);
	const displayCanvasRef = useRef<HTMLCanvasElement>(null);
	const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

	// 实际显示尺寸（CSS 像素），由容器自适应测量，避免外部传入尺寸不准
	const [viewSize, setViewSize] = useState<{ width: number; height: number }>(
		() => ({
			width: displaySize?.width || canvasSize.width,
			height: displaySize?.height || canvasSize.height,
		}),
	);

	const factorRef = useRef({ x: 1, y: 1 });
	factorRef.current = {
		x: canvasSize.width / Math.max(1, viewSize.width),
		y: canvasSize.height / Math.max(1, viewSize.height),
	};

	// 初始无选区（全遮罩），由用户拖拽创建——更贴近截图选区体验
	const [selectRect, setSelectRect] = useState<ElementRect>({
		min_x: 0,
		min_y: 0,
		max_x: 0,
		max_y: 0,
	});

	const dragModeRef = useRef<DragMode | undefined>(undefined);
	const dragStartRef = useRef<{
		x: number;
		y: number;
		rect: ElementRect;
	} | undefined>(undefined);

	// 测量容器真实显示尺寸
	useEffect(() => {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		const update = () => {
			const rect = el.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				setViewSize({ width: rect.width, height: rect.height });
			}
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => {
			ro.disconnect();
		};
	}, []);

	// 绘制显示画布（快照）
	useEffect(() => {
		const displayCanvas = displayCanvasRef.current;
		if (!displayCanvas) {
			return;
		}

		displayCanvas.width = canvasSize.width;
		displayCanvas.height = canvasSize.height;
		const ctx = displayCanvas.getContext("2d");
		if (!ctx) {
			return;
		}
		ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);
		ctx.drawImage(sourceCanvas, 0, 0);
	}, [sourceCanvas, canvasSize.width, canvasSize.height]);

	const drawOverlay = useCallback(() => {
		const overlayCanvas = overlayCanvasRef.current;
		if (!overlayCanvas) {
			return;
		}
		const ctx = overlayCanvas.getContext("2d");
		if (!ctx) {
			return;
		}

		const factor = factorRef.current;
		const dpr = window.devicePixelRatio || 1;

		const cssWidth = viewSize.width;
		const cssHeight = viewSize.height;
		if (
			overlayCanvas.width !== Math.round(cssWidth * dpr) ||
			overlayCanvas.height !== Math.round(cssHeight * dpr)
		) {
			overlayCanvas.width = Math.round(cssWidth * dpr);
			overlayCanvas.height = Math.round(cssHeight * dpr);
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssWidth, cssHeight);

		const hasSelection = isRectValid(selectRect);

		// 遮罩
		ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
		ctx.fillRect(0, 0, cssWidth, cssHeight);

		if (!hasSelection) {
			return;
		}

		const sx = selectRect.min_x / factor.x;
		const sy = selectRect.min_y / factor.y;
		const sw = (selectRect.max_x - selectRect.min_x) / factor.x;
		const sh = (selectRect.max_y - selectRect.min_y) / factor.y;

		// 透出选区内容
		ctx.clearRect(sx, sy, sw, sh);

		// 选区边框
		ctx.strokeStyle = token.colorPrimary;
		ctx.lineWidth = 1;
		ctx.strokeRect(sx, sy, sw, sh);

		// 拖拽手柄
		const handleSize = 10;
		ctx.fillStyle = token.colorWhite;
		ctx.strokeStyle = token.colorPrimary;
		const handlePoints: { x: number; y: number }[] = [
			{ x: sx, y: sy },
			{ x: sx + sw / 2, y: sy },
			{ x: sx + sw, y: sy },
			{ x: sx + sw, y: sy + sh / 2 },
			{ x: sx + sw, y: sy + sh },
			{ x: sx + sw / 2, y: sy + sh },
			{ x: sx, y: sy + sh },
			{ x: sx, y: sy + sh / 2 },
		];
		for (const point of handlePoints) {
			ctx.fillRect(
				point.x - handleSize / 2,
				point.y - handleSize / 2,
				handleSize,
				handleSize,
			);
			ctx.strokeRect(
				point.x - handleSize / 2,
				point.y - handleSize / 2,
				handleSize,
				handleSize,
			);
		}
	}, [selectRect, viewSize.width, viewSize.height, token.colorPrimary, token.colorWhite]);

	useEffect(() => {
		drawOverlay();
	}, [drawOverlay]);

	const getCanvasPosition = useCallback(
		(clientX: number, clientY: number) => {
			const el = containerRef.current;
			if (!el) {
				return { x: 0, y: 0 };
			}
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) {
				return { x: 0, y: 0 };
			}
			return {
				x: ((clientX - rect.left) * canvasSize.width) / rect.width,
				y: ((clientY - rect.top) * canvasSize.height) / rect.height,
			};
		},
		[canvasSize.width, canvasSize.height],
	);

	const getDragModeFromPosition = useCallback(
		(x: number, y: number): DragMode => {
			const sel = selectRect;
			if (!isRectValid(sel)) {
				return "create";
			}
			const factor = factorRef.current;
			const tolerance = 12 * Math.max(factor.x, factor.y);
			const handleCenters: { mode: DragMode; x: number; y: number }[] = [
				{ mode: "nw", x: sel.min_x, y: sel.min_y },
				{ mode: "n", x: (sel.min_x + sel.max_x) / 2, y: sel.min_y },
				{ mode: "ne", x: sel.max_x, y: sel.min_y },
				{ mode: "e", x: sel.max_x, y: (sel.min_y + sel.max_y) / 2 },
				{ mode: "se", x: sel.max_x, y: sel.max_y },
				{ mode: "s", x: (sel.min_x + sel.max_x) / 2, y: sel.max_y },
				{ mode: "sw", x: sel.min_x, y: sel.max_y },
				{ mode: "w", x: sel.min_x, y: (sel.min_y + sel.max_y) / 2 },
			];
			for (const handle of handleCenters) {
				if (
					Math.abs(x - handle.x) <= tolerance &&
					Math.abs(y - handle.y) <= tolerance
				) {
					return handle.mode;
				}
			}
			// 选区内部 → 移动；选区外部 → 重新框选
			if (
				x > sel.min_x &&
				x < sel.max_x &&
				y > sel.min_y &&
				y < sel.max_y
			) {
				return "move";
			}
			return "create";
		},
		[selectRect],
	);

	const onPointerDown = useCallback(
		(e: React.PointerEvent<HTMLCanvasElement>) => {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			try {
				overlayCanvasRef.current?.setPointerCapture(e.pointerId);
			} catch {
				// ignore
			}

			const pos = getCanvasPosition(e.clientX, e.clientY);
			const mode = getDragModeFromPosition(pos.x, pos.y);
			dragModeRef.current = mode;
			dragStartRef.current = {
				x: pos.x,
				y: pos.y,
				rect:
					mode === "create"
						? { min_x: pos.x, min_y: pos.y, max_x: pos.x, max_y: pos.y }
						: { ...selectRect },
			};
		},
		[getCanvasPosition, getDragModeFromPosition, selectRect],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent<HTMLCanvasElement>) => {
			if (!dragModeRef.current || !dragStartRef.current) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();

			const pos = getCanvasPosition(e.clientX, e.clientY);
			const dx = pos.x - dragStartRef.current.x;
			const dy = pos.y - dragStartRef.current.y;
			const orig = dragStartRef.current.rect;
			const canvasW = canvasSize.width;
			const canvasH = canvasSize.height;
			const minSize = 1;
			const mode = dragModeRef.current;

			if (mode === "create") {
				const newMaxX = clamp(Math.max(orig.min_x, pos.x), 0, canvasW);
				const newMaxY = clamp(Math.max(orig.min_y, pos.y), 0, canvasH);
				setSelectRect({
					min_x: orig.min_x,
					min_y: orig.min_y,
					max_x: newMaxX,
					max_y: newMaxY,
				});
				return;
			}

			if (mode === "move") {
				const selW = orig.max_x - orig.min_x;
				const selH = orig.max_y - orig.min_y;
				const newMinX = clamp(orig.min_x + dx, 0, canvasW - selW);
				const newMinY = clamp(orig.min_y + dy, 0, canvasH - selH);
				setSelectRect({
					min_x: newMinX,
					min_y: newMinY,
					max_x: newMinX + selW,
					max_y: newMinY + selH,
				});
				return;
			}

			const handle = HANDLE_LIST.find((item) => item.mode === mode);
			if (!handle) {
				return;
			}

			let { min_x, min_y, max_x, max_y } = orig;
			if (handle.edges.left) {
				min_x = clamp(pos.x, 0, orig.max_x - minSize);
			}
			if (handle.edges.right) {
				max_x = clamp(pos.x, orig.min_x + minSize, canvasW);
			}
			if (handle.edges.top) {
				min_y = clamp(pos.y, 0, orig.max_y - minSize);
			}
			if (handle.edges.bottom) {
				max_y = clamp(pos.y, orig.min_y + minSize, canvasH);
			}
			setSelectRect({ min_x, min_y, max_x, max_y });
		},
		[getCanvasPosition, canvasSize.width, canvasSize.height],
	);

	const onPointerUp = useCallback(
		(e: React.PointerEvent<HTMLCanvasElement>) => {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			try {
				overlayCanvasRef.current?.releasePointerCapture(e.pointerId);
			} catch {
				// ignore
			}
			dragModeRef.current = undefined;
			dragStartRef.current = undefined;
		},
		[],
	);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onCancel();
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (isRectValid(selectRect)) {
					onConfirm(selectRect);
				}
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [onCancel, onConfirm, selectRect]);

	const hasSelection = isRectValid(selectRect);

	// 裁剪控制按钮定位：复用工具栏的定位逻辑（相对选区、溢出翻转、屏幕内钳制）
	const cropButtonsRef = useRef<HTMLDivElement>(null);

	const updateCropButtonsPosition = useCallback(() => {
		const element = cropButtonsRef.current;
		const container = containerRef.current;
		if (!element || !container) {
			return;
		}

		const btnW = element.clientWidth;
		const btnH = element.clientHeight;
		if (btnW === 0 || btnH === 0) {
			// 按钮尚未完成布局，下一帧重试
			requestAnimationFrame(() => {
				updateCropButtonsPosition();
			});
			return;
		}

		const containerRect = container.getBoundingClientRect();
		const factor = factorRef.current;

		// 锚定矩形：有选区则相对选区，否则相对整个内容窗口
		const anchorMinX = hasSelection ? selectRect.min_x : 0;
		const anchorMinY = hasSelection ? selectRect.min_y : 0;
		const anchorMaxX = hasSelection ? selectRect.max_x : canvasSize.width;
		const anchorMaxY = hasSelection ? selectRect.max_y : canvasSize.height;

		const ax = anchorMinX / factor.x;
		const ay = anchorMinY / factor.y;
		const aw = (anchorMaxX - anchorMinX) / factor.x;
		const ah = (anchorMaxY - anchorMinY) / factor.y;

		// 主方案：选区下方，右对齐到选区右侧（与工具栏逻辑一致）
		const mainOffset = {
			x: containerRect.left + ax + aw - btnW,
			y: containerRect.top + ay + ah + token.margin,
		};
		const origin = new MousePosition(0, 0);
		let dragRes = updateElementPosition(
			element,
			mainOffset.x,
			mainOffset.y,
			origin,
			origin,
			undefined,
			false,
			1,
		);

		// 溢出底部时翻转到选区上方（与工具栏溢出回退逻辑一致）
		if (dragRes.isBeyondMaxY) {
			const aboveOffset = {
				x: containerRect.left + ax + aw - btnW,
				y: containerRect.top + ay - btnH - token.margin,
			};
			const temp = updateElementPosition(
				element,
				aboveOffset.x,
				aboveOffset.y,
				origin,
				origin,
				undefined,
				false,
				1,
			);
			if (!(temp.isBeyondMaxY || temp.isBeyondMinY)) {
				dragRes = temp;
			}
		}

		element.style.opacity = "1";
	}, [
		selectRect,
		canvasSize.width,
		canvasSize.height,
		viewSize.width,
		viewSize.height,
		token.margin,
	]);

	// 布局阶段即计算位置，避免按钮在 (0,0) 闪烁
	useLayoutEffect(() => {
		updateCropButtonsPosition();
	}, [updateCropButtonsPosition]);

	// 窗口尺寸变化时重新计算，避免超出屏幕消失
	useEffect(() => {
		window.addEventListener("resize", updateCropButtonsPosition);
		return () => {
			window.removeEventListener("resize", updateCropButtonsPosition);
		};
	}, [updateCropButtonsPosition]);

	return (
		<div
			ref={containerRef}
			className="fixed-content-crop-layer"
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				zIndex: zIndexs.FixedToScreen_CloseButton + 1,
				pointerEvents: "auto",
				cursor:
					dragModeRef.current === "create"
						? "crosshair"
						: dragModeRef.current === "move"
							? "move"
							: "default",
				userSelect: "none",
			}}
			onWheel={(e) => {
				e.stopPropagation();
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
		>
			<canvas
				ref={displayCanvasRef}
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: "100%",
				}}
			/>
			<canvas
				ref={overlayCanvasRef}
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: "100%",
					zIndex: 1,
					touchAction: "none",
				}}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
			/>

			{!hasSelection && (
				<div
					style={{
						position: "absolute",
						top: "50%",
						left: "50%",
						transform: "translate(-50%, -50%)",
						color: token.colorWhite,
						fontSize: 14,
						pointerEvents: "none",
						zIndex: 2,
						textShadow: "0 1px 2px rgba(0,0,0,0.6)",
					}}
				>
					{intl.formatMessage({ id: "draw.crop.hint" })}
				</div>
			)}

			<div
				ref={cropButtonsRef}
				style={{
					position: "fixed",
					left: 0,
					top: 0,
					opacity: 0,
					display: "flex",
					gap: token.paddingXS,
					zIndex: 2,
					pointerEvents: "auto",
				}}
				onPointerDown={(e) => {
					// 防止点击按钮时触发底层 canvas 的指针捕获/拖拽
					e.stopPropagation();
				}}
			>
				<Button
					icon={<CloseOutlined />}
					onClick={onCancel}
				>
					<FormattedMessage id="draw.crop.cancel" />
				</Button>
				<Button
					icon={<ReloadOutlined />}
					disabled={!hasSelection}
					onClick={() => {
						setSelectRect({ min_x: 0, min_y: 0, max_x: 0, max_y: 0 });
					}}
				>
					<FormattedMessage id="draw.crop.reset" />
				</Button>
				<Button
					type="primary"
					icon={<CheckOutlined />}
					disabled={!hasSelection}
					onClick={() => {
						if (isRectValid(selectRect)) {
							onConfirm(selectRect);
						}
					}}
				>
					<FormattedMessage id="draw.confirm" />
				</Button>
			</div>

			<style jsx>{`
				.fixed-content-crop-layer :global(canvas) {
					display: block;
				}
			`}</style>
		</div>
	);
};
