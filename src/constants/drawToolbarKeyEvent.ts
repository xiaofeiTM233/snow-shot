import {
	type DrawToolbarKeyEventComponentValue,
	DrawToolbarKeyEventKey,
	type DrawToolbarKeyEventValue,
} from "@/types/components/drawToolbar";
import { getPlatformValue } from "@/utils/platform";

export const defaultDrawToolbarKeyEventSettings: Record<
	DrawToolbarKeyEventKey,
	DrawToolbarKeyEventValue
> = {
	[DrawToolbarKeyEventKey.MoveTool]: {
		hotKey: "M",
		unique: true,
	},
	[DrawToolbarKeyEventKey.SelectTool]: {
		hotKey: "V",
		unique: true,
	},
	[DrawToolbarKeyEventKey.LockDrawTool]: {
		hotKey: getPlatformValue("Ctrl+Alt+L", "Meta+Alt+L"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.RectTool]: {
		hotKey: "1",
		unique: true,
	},
	[DrawToolbarKeyEventKey.EllipseTool]: {
		hotKey: "2",
		unique: true,
	},
	[DrawToolbarKeyEventKey.ArrowTool]: {
		hotKey: "3",
		unique: true,
	},
	[DrawToolbarKeyEventKey.PenTool]: {
		hotKey: "4",
		unique: true,
	},
	[DrawToolbarKeyEventKey.TextTool]: {
		hotKey: "5, T",
		unique: true,
	},
	[DrawToolbarKeyEventKey.SerialNumberTool]: {
		hotKey: "6",
		unique: true,
	},
	[DrawToolbarKeyEventKey.BlurTool]: {
		hotKey: "7",
		unique: true,
	},
	[DrawToolbarKeyEventKey.EraserTool]: {
		hotKey: "8, E",
		unique: true,
	},
	[DrawToolbarKeyEventKey.UndoTool]: {
		hotKey: getPlatformValue("Ctrl+Z", "Meta+Z"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.RedoTool]: {
		hotKey: getPlatformValue("Ctrl+Y", "Meta+Y"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.CancelTool]: {
		hotKey: "Escape",
		unique: true,
	},
	[DrawToolbarKeyEventKey.FixedTool]: {
		hotKey: getPlatformValue("Ctrl+F", "Meta+F"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.CopyTool]: {
		hotKey: getPlatformValue("Ctrl+C, Enter", "Meta+C, Enter"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.OcrDetectTool]: {
		hotKey: getPlatformValue("Ctrl+D", "Meta+D"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.OcrTranslateTool]: {
		hotKey: getPlatformValue("Ctrl+T", "Meta+T"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.SaveToCloudTool]: {
		hotKey: getPlatformValue("Ctrl+Shift+C", "Meta+Shift+C"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.ScrollScreenshotTool]: {
		hotKey: "L",
		unique: true,
	},
	[DrawToolbarKeyEventKey.SaveTool]: {
		hotKey: getPlatformValue("Ctrl+S", "Meta+S"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.FastSaveTool]: {
		hotKey: getPlatformValue("Ctrl+Shift+S", "Meta+Shift+S"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.ColorPickerCopy]: {
		hotKey: "C",
		unique: true,
	},
	[DrawToolbarKeyEventKey.SerialNumberDisableArrow]: {
		hotKey: "Shift",
	},
	[DrawToolbarKeyEventKey.ResizeFromCenterPicker]: {
		hotKey: "Alt",
	},
	[DrawToolbarKeyEventKey.MaintainAspectRatioPicker]: {
		hotKey: "Shift",
	},
	[DrawToolbarKeyEventKey.RotateWithDiscreteAnglePicker]: {
		hotKey: "Shift",
	},
	[DrawToolbarKeyEventKey.AutoAlignPicker]: {
		hotKey: getPlatformValue("Ctrl", "Meta"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.SwitchColorFormat]: {
		hotKey: "Shift",
	},
	[DrawToolbarKeyEventKey.RemoveTool]: {
		hotKey: "Delete",
		unique: true,
	},
	[DrawToolbarKeyEventKey.SelectPrevRectTool]: {
		hotKey: "R",
		unique: true,
	},
	[DrawToolbarKeyEventKey.DragSelectRect]: {
		hotKey: "Space",
	},
	[DrawToolbarKeyEventKey.LockWidthHeightPicker]: {
		hotKey: "Shift",
	},
	[DrawToolbarKeyEventKey.PreviousCapture]: {
		hotKey: "Comma",
		unique: true,
	},
	[DrawToolbarKeyEventKey.NextCapture]: {
		hotKey: "Period",
		unique: true,
	},
	[DrawToolbarKeyEventKey.ColorPickerMoveUp]: {
		hotKey: "W, ArrowUp",
		unique: true,
	},
	[DrawToolbarKeyEventKey.ColorPickerMoveDown]: {
		hotKey: "S, ArrowDown",
		unique: true,
	},
	[DrawToolbarKeyEventKey.ColorPickerMoveLeft]: {
		hotKey: "A, ArrowLeft",
		unique: true,
	},
	[DrawToolbarKeyEventKey.ColorPickerMoveRight]: {
		hotKey: "D, ArrowRight",
		unique: true,
	},
	[DrawToolbarKeyEventKey.LaserPointerTool]: {
		hotKey: getPlatformValue("Ctrl+L", "Meta+L"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.ResetCanvasTool]: {
		hotKey: getPlatformValue("Ctrl+R", "Meta+R"),
		unique: true,
	},
	[DrawToolbarKeyEventKey.OpenTranslationTool]: {
		hotKey: "",
		unique: true,
	},
};

const DrawToolbarKeyEventSettingsKeys = Object.keys(
	defaultDrawToolbarKeyEventSettings,
);
export const defaultDrawToolbarKeyEventComponentConfig: Record<
	DrawToolbarKeyEventKey,
	DrawToolbarKeyEventComponentValue
> = DrawToolbarKeyEventSettingsKeys.reduce(
	(acc, key) => {
		acc[key as DrawToolbarKeyEventKey] = {
			...defaultDrawToolbarKeyEventSettings[key as DrawToolbarKeyEventKey],
			messageId: `draw.${key}`,
		};
		return acc;
	},
	{} as Record<DrawToolbarKeyEventKey, DrawToolbarKeyEventComponentValue>,
);
