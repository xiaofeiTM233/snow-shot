import {
	CheckOutlined,
	CloseOutlined,
	CopyOutlined,
	DragOutlined,
	LockOutlined,
	ScanOutlined,
	UndoOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";
import {
	ArrowIcon,
	ArrowSelectIcon,
	CircleIcon,
	CropIcon,
	DiamondIcon,
	EraserIcon,
	FastSaveIcon,
	FilterFreeDrawIcon,
	FilterIcon,
	FixedIcon,
	HighlightIcon,
	LaserPointerIcon,
	LineIcon,
	MouseThroughIcon,
	OcrDetectIcon,
	OcrTranslateIcon,
	PenIcon,
	RectIcon,
	ResetCanvasIcon,
	SaveIcon,
	SaveToCloudIcon,
	ScrollScreenshotIcon,
	SerialNumberIcon,
	TextIcon,
	TranslationIcon,
	VideoRecordIcon,
	WatermarkIcon,
} from "@/components/icons";
import { DrawState } from "@/types/draw";
import {
	type ToolbarGroupsMap,
	ToolbarId,
	ToolbarToolKey,
} from "@/types/toolbarTool";

/** 工具分组，相邻不同分组的工具之间自动渲染分隔线 */
export type ToolbarToolGroup =
	| "edit"
	| "draw"
	| "history"
	| "action"
	| "confirm";

export type ToolbarToolDefinition = {
	key: ToolbarToolKey;
	/** 工具名称的 i18n key */
	i18nId: string;
	icon: ReactNode;
	group: ToolbarToolGroup;
	/** 出现在哪些工具栏 */
	toolbars: ToolbarId[];
};

/**
 * 工具注册表。所有工具都是一等工具；组合（Popover）关系由布局数据
 * `toolbarGroups`（head → members）描述，见 DEFAULT_TOOLBAR_GROUPS。
 * 贴图工具栏的拖动窗口按钮是窗口锚点，固定渲染在头部，不参与排序与显隐，故未注册。
 */
export const TOOLBAR_TOOL_DEFINITIONS: Partial<
	Record<ToolbarToolKey, ToolbarToolDefinition>
> = {
	[ToolbarToolKey.MoveTool]: {
		key: ToolbarToolKey.MoveTool,
		i18nId: "draw.moveTool",
		icon: <DragOutlined />,
		group: "edit",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.SelectTool]: {
		key: ToolbarToolKey.SelectTool,
		i18nId: "draw.selectTool",
		icon: <ArrowSelectIcon />,
		group: "edit",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.LockTool]: {
		key: ToolbarToolKey.LockTool,
		i18nId: "draw.lockDrawTool",
		icon: <LockOutlined />,
		group: "edit",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.RectTool]: {
		key: ToolbarToolKey.RectTool,
		i18nId: "draw.rectTool",
		icon: <RectIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.DiamondTool]: {
		key: ToolbarToolKey.DiamondTool,
		i18nId: "draw.diamondTool",
		icon: <DiamondIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.EllipseTool]: {
		key: ToolbarToolKey.EllipseTool,
		i18nId: "draw.ellipseTool",
		icon: <CircleIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.ArrowTool]: {
		key: ToolbarToolKey.ArrowTool,
		i18nId: "draw.arrowTool",
		icon: <ArrowIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.LineTool]: {
		key: ToolbarToolKey.LineTool,
		i18nId: "draw.lineTool",
		icon: <LineIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.PenTool]: {
		key: ToolbarToolKey.PenTool,
		i18nId: "draw.penTool",
		icon: <PenIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.TextTool]: {
		key: ToolbarToolKey.TextTool,
		i18nId: "draw.textTool",
		icon: <TextIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.SerialNumberTool]: {
		key: ToolbarToolKey.SerialNumberTool,
		i18nId: "draw.serialNumberTool",
		icon: <SerialNumberIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.BlurTool]: {
		key: ToolbarToolKey.BlurTool,
		i18nId: "draw.blurTool",
		icon: <FilterIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.BlurFreeDrawTool]: {
		key: ToolbarToolKey.BlurFreeDrawTool,
		i18nId: "draw.blurFreeDrawTool",
		icon: <FilterFreeDrawIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.EraserTool]: {
		key: ToolbarToolKey.EraserTool,
		i18nId: "draw.eraserTool",
		icon: <EraserIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.WatermarkTool]: {
		key: ToolbarToolKey.WatermarkTool,
		i18nId: "draw.watermarkTool",
		icon: <WatermarkIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.HighlightTool]: {
		key: ToolbarToolKey.HighlightTool,
		i18nId: "draw.highlightTool",
		icon: <HighlightIcon />,
		group: "draw",
		toolbars: [ToolbarId.Main, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.HistoryTool]: {
		key: ToolbarToolKey.HistoryTool,
		i18nId: "draw.redoUndoTool",
		icon: <UndoOutlined />,
		group: "history",
		toolbars: [ToolbarId.Main, ToolbarId.FixedContent],
	},
	[ToolbarToolKey.ScanQrcodeTool]: {
		key: ToolbarToolKey.ScanQrcodeTool,
		i18nId: "draw.extraTool.scanQrcode",
		icon: <ScanOutlined />,
		group: "action",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.VideoRecordTool]: {
		key: ToolbarToolKey.VideoRecordTool,
		i18nId: "draw.extraTool.videoRecord",
		icon: <VideoRecordIcon />,
		group: "action",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.FixedTool]: {
		key: ToolbarToolKey.FixedTool,
		i18nId: "draw.fixedTool",
		icon: <FixedIcon />,
		group: "action",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.OcrDetectTool]: {
		key: ToolbarToolKey.OcrDetectTool,
		i18nId: "draw.ocrDetectTool",
		icon: <OcrDetectIcon />,
		group: "action",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.OcrTranslateTool]: {
		key: ToolbarToolKey.OcrTranslateTool,
		i18nId: "draw.ocrTranslateTool",
		icon: <OcrTranslateIcon />,
		group: "action",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.OpenTranslationTool]: {
		key: ToolbarToolKey.OpenTranslationTool,
		i18nId: "draw.openTranslationTool",
		icon: <TranslationIcon />,
		group: "action",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.ScrollScreenshotTool]: {
		key: ToolbarToolKey.ScrollScreenshotTool,
		i18nId: "draw.scrollScreenshotTool",
		icon: <ScrollScreenshotIcon />,
		group: "action",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.FastSaveTool]: {
		key: ToolbarToolKey.FastSaveTool,
		i18nId: "draw.fastSaveTool",
		icon: <FastSaveIcon />,
		group: "action",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.SaveToCloudTool]: {
		key: ToolbarToolKey.SaveToCloudTool,
		i18nId: "draw.saveToCloudTool",
		icon: <SaveToCloudIcon />,
		group: "action",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.SaveTool]: {
		key: ToolbarToolKey.SaveTool,
		i18nId: "draw.saveTool",
		icon: <SaveIcon />,
		group: "action",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.CancelTool]: {
		key: ToolbarToolKey.CancelTool,
		i18nId: "draw.cancelTool",
		icon: <CloseOutlined />,
		group: "confirm",
		toolbars: [ToolbarId.Main, ToolbarId.FullScreen],
	},
	[ToolbarToolKey.CopyTool]: {
		key: ToolbarToolKey.CopyTool,
		i18nId: "draw.copyTool",
		icon: <CopyOutlined />,
		group: "confirm",
		toolbars: [ToolbarId.Main],
	},
	[ToolbarToolKey.LaserPointerTool]: {
		key: ToolbarToolKey.LaserPointerTool,
		i18nId: "draw.laserPointerTool",
		icon: <LaserPointerIcon />,
		group: "draw",
		toolbars: [ToolbarId.FullScreen],
	},
	[ToolbarToolKey.ResetCanvasTool]: {
		key: ToolbarToolKey.ResetCanvasTool,
		i18nId: "draw.resetCanvasTool",
		icon: <ResetCanvasIcon />,
		group: "action",
		toolbars: [ToolbarId.FullScreen],
	},
	[ToolbarToolKey.MouseThroughTool]: {
		key: ToolbarToolKey.MouseThroughTool,
		i18nId: "draw.mouseThroughTool",
		icon: <MouseThroughIcon />,
		group: "action",
		toolbars: [ToolbarId.FullScreen],
	},
	[ToolbarToolKey.CropTool]: {
		key: ToolbarToolKey.CropTool,
		i18nId: "draw.crop",
		icon: <CropIcon />,
		group: "edit",
		toolbars: [ToolbarId.FixedContent],
	},
	[ToolbarToolKey.ConfirmTool]: {
		key: ToolbarToolKey.ConfirmTool,
		i18nId: "draw.confirm",
		icon: <CheckOutlined />,
		group: "confirm",
		toolbars: [ToolbarId.FixedContent],
	},
};

/** 各工具栏的默认组合（head → members），与默认顺序配合还原原有工具栏形态 */
export const DEFAULT_TOOLBAR_GROUPS: Record<
	ToolbarId,
	Partial<Record<ToolbarToolKey, ToolbarToolKey[]>>
> = {
	[ToolbarId.Main]: {
		[ToolbarToolKey.RectTool]: [ToolbarToolKey.DiamondTool],
		[ToolbarToolKey.ArrowTool]: [ToolbarToolKey.LineTool],
		[ToolbarToolKey.BlurTool]: [ToolbarToolKey.BlurFreeDrawTool],
		[ToolbarToolKey.HighlightTool]: [ToolbarToolKey.WatermarkTool],
		[ToolbarToolKey.VideoRecordTool]: [ToolbarToolKey.ScanQrcodeTool],
	},
	[ToolbarId.FullScreen]: {
		[ToolbarToolKey.RectTool]: [ToolbarToolKey.DiamondTool],
		[ToolbarToolKey.ArrowTool]: [ToolbarToolKey.LineTool],
	},
	[ToolbarId.FixedContent]: {
		[ToolbarToolKey.RectTool]: [ToolbarToolKey.DiamondTool],
		[ToolbarToolKey.ArrowTool]: [ToolbarToolKey.LineTool],
		[ToolbarToolKey.BlurTool]: [ToolbarToolKey.BlurFreeDrawTool],
		[ToolbarToolKey.HighlightTool]: [ToolbarToolKey.WatermarkTool],
	},
};

/** 各工具栏的默认工具顺序（不含固定在头部的拖动柄与拖动窗口按钮；组合占一个槽位，键为 head） */
export const DEFAULT_TOOLBAR_TOOL_ORDER: Record<ToolbarId, ToolbarToolKey[]> = {
	[ToolbarId.Main]: [
		ToolbarToolKey.MoveTool,
		ToolbarToolKey.SelectTool,
		ToolbarToolKey.LockTool,
		ToolbarToolKey.RectTool,
		ToolbarToolKey.EllipseTool,
		ToolbarToolKey.ArrowTool,
		ToolbarToolKey.PenTool,
		ToolbarToolKey.TextTool,
		ToolbarToolKey.SerialNumberTool,
		ToolbarToolKey.BlurTool,
		ToolbarToolKey.EraserTool,
		ToolbarToolKey.HighlightTool,
		ToolbarToolKey.HistoryTool,
		ToolbarToolKey.VideoRecordTool,
		ToolbarToolKey.FixedTool,
		ToolbarToolKey.OcrDetectTool,
		ToolbarToolKey.OcrTranslateTool,
		ToolbarToolKey.OpenTranslationTool,
		ToolbarToolKey.ScrollScreenshotTool,
		ToolbarToolKey.FastSaveTool,
		ToolbarToolKey.SaveToCloudTool,
		ToolbarToolKey.SaveTool,
		ToolbarToolKey.CancelTool,
		ToolbarToolKey.CopyTool,
	],
	[ToolbarId.FullScreen]: [
		ToolbarToolKey.SelectTool,
		ToolbarToolKey.LockTool,
		ToolbarToolKey.RectTool,
		ToolbarToolKey.EllipseTool,
		ToolbarToolKey.ArrowTool,
		ToolbarToolKey.PenTool,
		ToolbarToolKey.TextTool,
		ToolbarToolKey.SerialNumberTool,
		ToolbarToolKey.EraserTool,
		ToolbarToolKey.LaserPointerTool,
		ToolbarToolKey.ResetCanvasTool,
		ToolbarToolKey.MouseThroughTool,
		ToolbarToolKey.CancelTool,
	],
	[ToolbarId.FixedContent]: [
		ToolbarToolKey.SelectTool,
		ToolbarToolKey.LockTool,
		ToolbarToolKey.CropTool,
		ToolbarToolKey.RectTool,
		ToolbarToolKey.EllipseTool,
		ToolbarToolKey.ArrowTool,
		ToolbarToolKey.PenTool,
		ToolbarToolKey.TextTool,
		ToolbarToolKey.SerialNumberTool,
		ToolbarToolKey.BlurTool,
		ToolbarToolKey.EraserTool,
		ToolbarToolKey.HighlightTool,
		ToolbarToolKey.HistoryTool,
		ToolbarToolKey.ConfirmTool,
	],
};

export const isToolbarToolKey = (value: unknown): value is ToolbarToolKey => {
	return (
		typeof value === "string" &&
		Object.values(ToolbarToolKey).includes(value as ToolbarToolKey)
	);
};

/** 工具栏可用的工具键（含可作为组合成员的全部工具） */
export const getToolbarAvailableKeys = (
	toolbarId: ToolbarId,
): Set<ToolbarToolKey> => {
	const keys = new Set<ToolbarToolKey>();
	for (const definition of Object.values(TOOLBAR_TOOL_DEFINITIONS)) {
		if (definition?.toolbars.includes(toolbarId)) {
			keys.add(definition.key);
		}
	}
	return keys;
};

/** 校验并去重工具 key 列表，非法项剔除 */
export const parseToolbarToolKeyList = (
	value: unknown,
	fallback: ToolbarToolKey[],
): ToolbarToolKey[] => {
	if (!Array.isArray(value)) {
		return fallback;
	}

	const result: ToolbarToolKey[] = [];
	for (const item of value) {
		if (isToolbarToolKey(item) && !result.includes(item)) {
			result.push(item);
		}
	}
	return result;
};

/**
 * 校验组合表：过滤非法键、去重成员、成员不与 head 重复、
 * 成员不作为其他组合的 head（不支持嵌套）、每个工具最多属于一个组合。
 */
export const normalizeToolbarGroupsMap = (
	value: unknown,
	availableKeys: Set<ToolbarToolKey>,
	fallback: ToolbarGroupsMap,
): ToolbarGroupsMap => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return fallback;
	}

	const rawMap = value as Record<string, unknown>;
	const result: ToolbarGroupsMap = {};
	const usedMembers = new Set<ToolbarToolKey>();

	for (const [rawHead, rawMembers] of Object.entries(rawMap)) {
		if (!isToolbarToolKey(rawHead) || !availableKeys.has(rawHead)) {
			continue;
		}
		if (!Array.isArray(rawMembers)) {
			continue;
		}

		const members: ToolbarToolKey[] = [];
		for (const rawMember of rawMembers) {
			if (
				isToolbarToolKey(rawMember) &&
				availableKeys.has(rawMember) &&
				rawMember !== rawHead &&
				!members.includes(rawMember) &&
				!usedMembers.has(rawMember) &&
				// 成员不能是其他组合的 head（不支持嵌套组合）
				!(rawMember in rawMap)
			) {
				members.push(rawMember);
				usedMembers.add(rawMember);
			}
		}

		if (members.length > 0) {
			result[rawHead] = members;
		}
	}

	return result;
};

/** 校验组合最后使用成员表（head → 成员键） */
export const parseToolbarLastUsedToolMap = (
	value: unknown,
	fallback: Partial<Record<ToolbarToolKey, ToolbarToolKey>>,
): Partial<Record<ToolbarToolKey, ToolbarToolKey>> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return fallback;
	}

	const result: Partial<Record<ToolbarToolKey, ToolbarToolKey>> = {};
	for (const [rawHead, rawMember] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (isToolbarToolKey(rawHead) && isToolbarToolKey(rawMember)) {
			result[rawHead] = rawMember;
		}
	}
	return result;
};

/** 旧版 toolbarHiddenToolList（DrawState 列表）到 ToolbarToolKey 的迁移映射 */
export const LEGACY_HIDDEN_TOOL_LIST_MAP: Record<number, ToolbarToolKey> = {
	[DrawState.Select]: ToolbarToolKey.SelectTool,
	[DrawState.Ellipse]: ToolbarToolKey.EllipseTool,
	[DrawState.Arrow]: ToolbarToolKey.ArrowTool,
	[DrawState.Pen]: ToolbarToolKey.PenTool,
	[DrawState.Text]: ToolbarToolKey.TextTool,
	[DrawState.SerialNumber]: ToolbarToolKey.SerialNumberTool,
	[DrawState.Blur]: ToolbarToolKey.BlurTool,
	[DrawState.BlurFreeDraw]: ToolbarToolKey.BlurFreeDrawTool,
	[DrawState.Watermark]: ToolbarToolKey.WatermarkTool,
	[DrawState.Highlight]: ToolbarToolKey.HighlightTool,
	[DrawState.Eraser]: ToolbarToolKey.EraserTool,
	[DrawState.Redo]: ToolbarToolKey.HistoryTool,
	[DrawState.Fixed]: ToolbarToolKey.FixedTool,
	[DrawState.OcrDetect]: ToolbarToolKey.OcrDetectTool,
	[DrawState.OcrTranslate]: ToolbarToolKey.OcrTranslateTool,
	[DrawState.ScrollScreenshot]: ToolbarToolKey.ScrollScreenshotTool,
};
