import { CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { Button, theme } from "antd";
import React, {
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { zIndexs } from "@/utils/zIndex";
import type { ElementRect } from "@/types/commands/screenshot";

export type CropLayerProps = {
	/** 当前内容的快照（画布坐标系分辨率，即画布原始像素） */
	sourceCanvas: HTMLCanvasElement;
	/** 画布坐标系尺寸 */
	canvasSize: { width: number; height: number };
	/** 显示尺寸（CSS 像素，等于窗口内容显示尺寸） */
	displaySize: { width: number; height: number };
	onConfirm: (cropRect: ElementRect) => void;
	onCancel: () => void;
};

type DragMode =
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

	const factorRef = useRef({ x: 1, y: 1 });
	factorRef.current = {
		x: canvasSize.width / Math.max(1, displaySize.width),
		y: canvasSize.height / Math.max(1, displaySize.height),
	};

	const [selectRect, setSelectRect] = useState<ElementRect>({
		min_x: 0,
		min_y: 0,
		max_x: canvasSize.width,
		max_y: canvasSize.height,
	});

	const dragModeRef = useRef<DragMode | undefined>(undefined);
	const dragStartRef = useRef<{
		x: number;
		y: number;
		rect: ElementRect;
	} | undefined>(undefined);

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

		// 使用 CSS 像素作为绘制坐标系，保证清晰度与交互一致
		const cssWidth = displaySize.width;
		const cssHeight = displaySize.height;
		if (
			overlayCanvas.width !== Math.round(cssWidth * dpr) ||
			overlayCanvas.height !== Math.round(cssHeight * dpr)
		) {
			overlayCanvas.width = Math.round(cssWidth * dpr);
			overlayCanvas.height = Math.round(cssHeight * dpr);
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssWidth, cssHeight);

		const sx = selectRect.min_x / factor.x;
		const sy = selectRect.min_y / factor.y;
		const sw = (selectRect.max_x - selectRect.min_x) / factor.x;
		const sh = (selectRect.max_y - selectRect.min_y) / factor.y;

		// 遮罩
		ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
		ctx.fillRect(0, 0, cssWidth, cssHeight);
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
	}, [selectRect, displaySize.width, displaySize.height, token.colorPrimary, token.colorWhite]);

	useEffect(() => {
		drawOverlay();
	}, [drawOverlay]);

	const getCanvasPosition = useCallback(
		(clientX: number, clientY: number) => {
			const overlayCanvas = overlayCanvasRef.current;
			if (!overlayCanvas) {
				return { x: 0, y: 0 };
			}
			const rect = overlayCanvas.getBoundingClientRect();
			const factor = factorRef.current;
			return {
				x: ((clientX - rect.left) * factor.x) / (rect.width / displaySize.width),
				y: ((clientY - rect.top) * factor.y) / (rect.height / displaySize.height),
			};
		},
		[displaySize.width, displaySize.height],
	);

	const getDragModeFromPosition = useCallback(
		(x: number, y: number): DragMode => {
			const factor = factorRef.current;
			const tolerance = 12 * Math.max(factor.x, factor.y);
			const sel = selectRect;
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
			return "move";
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
				rect: { ...selectRect },
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
			const handle = HANDLE_LIST.find((item) => item.mode === mode);
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

	const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
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
	}, []);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onCancel();
			} else if (e.key === "Enter") {
				e.preventDefault();
				onConfirm(selectRect);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [onCancel, onConfirm, selectRect]);

	return (
		<div
			ref={containerRef}
			className="fixed-content-crop-layer"
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				width: `${displaySize.width}px`,
				height: `${displaySize.height}px`,
				zIndex: zIndexs.FixedToScreen_CloseButton + 1,
				pointerEvents: "auto",
				cursor: dragModeRef.current === "move" ? "move" : "crosshair",
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
					width: `${displaySize.width}px`,
					height: `${displaySize.height}px`,
				}}
			/>
			<canvas
				ref={overlayCanvasRef}
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: `${displaySize.width}px`,
					height: `${displaySize.height}px`,
					touchAction: "none",
				}}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
			/>

			<div
				style={{
					position: "absolute",
					bottom: token.margin,
					left: "50%",
					transform: "translateX(-50%)",
					display: "flex",
					gap: token.paddingXS,
					zIndex: zIndexs.FixedToScreen_CloseButton + 2,
				}}
			>
				<Button
					icon={<CloseOutlined />}
					onClick={onCancel}
				>
					<FormattedMessage id="draw.crop.cancel" />
				</Button>
				<Button
					type="primary"
					icon={<CheckOutlined />}
					onClick={() => {
						onConfirm(selectRect);
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
