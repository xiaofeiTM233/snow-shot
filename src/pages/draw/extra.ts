import type { ColorInstance } from "color";
import { last } from "es-toolkit";
import Flatbush from "flatbush";
import type { MonitorInfo } from "@/commands/core";
import type { ImageLayerActionType } from "@/components/imageLayer";
import { createPublisher } from "@/hooks/useStatePublisher";
import type { ElementRect, ImageBuffer } from "@/types/commands/screenshot";
import { MousePosition } from "@/utils/mousePosition";
import { ScreenshotType } from "@/utils/types";
import type {
	SelectLayerActionType,
	SelectRectParams,
} from "./components/selectLayer";
import type { ImageSharedBufferData } from "./tools";
import { CanvasLayer, CaptureStep } from "./types";

export const switchLayer = (
	layer: CanvasLayer | undefined,
	imageLayerAction: ImageLayerActionType | undefined,
	selectLayerAction: SelectLayerActionType | undefined,
) => {
	let switchDraw = false;
	let switchSelect = false;

	switch (layer) {
		case CanvasLayer.Draw:
			switchDraw = true;
			break;
		case CanvasLayer.Select:
			switchSelect = true;
			break;
		default:
			break;
	}

	imageLayerAction?.setEnable(switchDraw);
	selectLayerAction?.setEnable(switchSelect);
};

export const getMonitorRect = (monitorInfo: MonitorInfo | undefined) => {
	return {
		min_x: 0,
		min_y: 0,
		max_x: monitorInfo?.monitor_width ?? 0,
		max_y: monitorInfo?.monitor_height ?? 0,
	};
};

export enum CaptureEvent {
	onExecuteScreenshot = "onExecuteScreenshot",
	onCaptureImageBufferReady = "onCaptureImageBufferReady",
	onCaptureReady = "onCaptureReady",
	onCaptureLoad = "onCaptureLoad",
	onCaptureFinish = "onCaptureFinish",
}

export type CaptureEventParams =
	| {
			event: CaptureEvent.onExecuteScreenshot;
	  }
	| {
			event: CaptureEvent.onCaptureImageBufferReady;
			params: {
				imageBuffer: ImageBuffer | ImageSharedBufferData | undefined;
			};
	  }
	| {
			event: CaptureEvent.onCaptureLoad;
			params: Parameters<ImageLayerActionType["onCaptureLoad"]>;
	  }
	| {
			event: CaptureEvent.onCaptureFinish;
	  }
	| {
			event: CaptureEvent.onCaptureReady;
			params: Parameters<ImageLayerActionType["onCaptureReady"]>;
	  };

export const CaptureStepPublisher = createPublisher<CaptureStep>(
	CaptureStep.Select,
);
export const CaptureLoadingPublisher = createPublisher<boolean>(true);
export const ElementDraggingPublisher = createPublisher<boolean>(false);
export const CaptureEventPublisher = createPublisher<
	CaptureEventParams | undefined
>(undefined, true);
export const ScreenshotTypePublisher = createPublisher<{
	type: ScreenshotType;
	params: {
		windowId?: string;
		captureHistoryId?: string;
	};
}>({
	type: ScreenshotType.Default,
	params: {},
});

export enum DrawEvent {
	ScrollScreenshot = 1,
	MoveCursor = 2,
	/** 选区所在的 monitor 发生变化，可能相同值重复触发 */
	ChangeMonitor = 3,
	/** 选区参数动画发生变化 */
	SelectRectParamsAnimationChange = 4,
	/** ColorPicker 颜色发生变化 */
	ColorPickerColorChange = 5,
	/** 清除上下文 */
	ClearContext = 6,
}

export type DrawEventParams =
	| {
			event: DrawEvent.ScrollScreenshot;
			params: undefined;
	  }
	| {
			event: DrawEvent.MoveCursor;
			params: {
				x: number;
				y: number;
			};
	  }
	| {
			event: DrawEvent.ChangeMonitor;
			params: {
				rect: MonitorRect;
			};
	  }
	| {
			event: DrawEvent.SelectRectParamsAnimationChange;
			params: {
				selectRectParams: SelectRectParams;
			};
	  }
	| {
			event: DrawEvent.ColorPickerColorChange;
			params: {
				color: ColorInstance;
			};
	  }
	| {
			event: DrawEvent.ClearContext;
			params: undefined;
	  }
	| undefined;

export const DrawEventPublisher = createPublisher<DrawEventParams>(
	undefined,
	true,
);

/**
 * 显示器范围
 */
export type MonitorRect = {
	/** 显示器范围 */
	rect: ElementRect;
	/** 显示器缩放 */
	scale_factor: number;
};

export class CaptureBoundingBoxInfo {
	rect: ElementRect;
	width: number;
	height: number;
	mousePosition: MousePosition;
	monitorRectList: MonitorRect[];
	monitorRTree: Flatbush;

	constructor(
		rect: ElementRect,
		monitorRectList: MonitorRect[],
		mousePosition: MousePosition,
	) {
		this.rect = rect;
		this.width = rect.max_x - rect.min_x;
		this.height = rect.max_y - rect.min_y;
		// 将显示器的鼠标位置转为相对截图窗口的鼠标位置
		this.mousePosition = new MousePosition(
			mousePosition.mouseX - rect.min_x,
			mousePosition.mouseY - rect.min_y,
		);
		// Flatbush 不接受 numItems=0（会抛 "Unexpected numItems value: 0"）。
		// 显示器列表为空时退化为「整窗即唯一显示器」：既让树可构建，又保证
		// getActiveMonitor 返回合法 MonitorRect 而不是 undefined。
		if (monitorRectList.length === 0) {
			this.monitorRectList = [{ rect: { ...this.rect }, scale_factor: 1 }];
			this.monitorRTree = new Flatbush(1);
			this.monitorRTree.add(
				this.rect.min_x,
				this.rect.min_y,
				this.rect.max_x,
				this.rect.max_y,
			);
			this.monitorRTree.finish();
			return;
		}

		this.monitorRectList = monitorRectList;
		this.monitorRTree = new Flatbush(monitorRectList.length);
		monitorRectList.forEach(({ rect }) => {
			this.monitorRTree.add(rect.min_x, rect.min_y, rect.max_x, rect.max_y);
		});
		this.monitorRTree.finish();
	}

	/**
	 * 将相对显示器的选区转换为相对于截图窗口的选区
	 * @param rect 选区
	 * @returns 相对于截图窗口的选区
	 */
	transformMonitorRect(rect: ElementRect) {
		return {
			min_x: rect.min_x - this.rect.min_x,
			min_y: rect.min_y - this.rect.min_y,
			max_x: rect.max_x - this.rect.min_x,
			max_y: rect.max_y - this.rect.min_y,
		};
	}

	/**
	 * 将相对于截图窗口的选区转换为相对于显示器的选区
	 * @param rect 选区
	 * @returns 相对于显示器的选区
	 */
	transformWindowRect(rect: ElementRect) {
		return {
			min_x: rect.min_x + this.rect.min_x,
			min_y: rect.min_y + this.rect.min_y,
			max_x: rect.max_x + this.rect.min_x,
			max_y: rect.max_y + this.rect.min_y,
		};
	}

	/**
	 * 获取选区所在的显示器索引
	 * @param selectedRect 选区
	 * @param querySelectedRectPoints 是否查询选区的所有点
	 * @returns 显示器索引列表
	 */
	getActiveMonitorIndex(
		selectedRect: ElementRect,
		querySelectedRectPoints: boolean = false,
	): number[] {
		// 优先遍历中心点
		const centerX =
			selectedRect.min_x + (selectedRect.max_x - selectedRect.min_x) / 2;
		const centerY =
			selectedRect.min_y + (selectedRect.max_y - selectedRect.min_y) / 2;
		let result = this.monitorRTree.search(centerX, centerY, centerX, centerY);

		if (result.length !== 0) {
			return result;
		}

		if (!querySelectedRectPoints) {
			return result;
		}

		// 左上
		result = this.monitorRTree.search(
			selectedRect.min_x,
			selectedRect.min_y,
			selectedRect.min_x,
			selectedRect.min_y,
		);

		if (result.length !== 0) {
			return result;
		}

		// 右上
		result = this.monitorRTree.search(
			selectedRect.max_x,
			selectedRect.min_y,
			selectedRect.max_x,
			selectedRect.min_y,
		);

		if (result.length !== 0) {
			return result;
		}

		// 左下
		result = this.monitorRTree.search(
			selectedRect.min_x,
			selectedRect.max_y,
			selectedRect.min_x,
			selectedRect.max_y,
		);

		if (result.length !== 0) {
			return result;
		}

		// 右下
		result = this.monitorRTree.search(
			selectedRect.max_x,
			selectedRect.max_y,
			selectedRect.max_x,
			selectedRect.max_y,
		);

		if (result.length !== 0) {
			return result;
		}

		return result;
	}

	getActiveMonitorRectList(selectedRect: ElementRect): ElementRect[] {
		const monitorRectIndexList = this.getActiveMonitorIndex(selectedRect);

		return monitorRectIndexList.map(
			(index) => this.monitorRectList[index].rect,
		);
	}

	getActiveMonitorRect(selectedRect: ElementRect) {
		const activeMonitorRectList = this.getActiveMonitorRectList(selectedRect);

		return (
			last(activeMonitorRectList) ?? {
				min_x: 0,
				min_y: 0,
				max_x: this.width,
				max_y: this.height,
			}
		);
	}

	getActiveMonitor(
		selectedRect: ElementRect,
		querySelectedRectPoints: boolean = false,
	) {
		const monitorRectIndexList = this.getActiveMonitorIndex(
			selectedRect,
			querySelectedRectPoints,
		);

		const lastIndex = last(monitorRectIndexList) ?? 0;

		return this.monitorRectList[lastIndex];
	}
}
