export type DrawToolbarKeyEventValue = {
	hotKey: string;
	unique?: boolean;
};

export type DrawToolbarKeyEventComponentValue = DrawToolbarKeyEventValue & {
	messageId: string;
};

export enum DrawToolbarKeyEventKey {
	MoveTool = "moveTool",
	SelectTool = "selectTool",
	LockDrawTool = "lockDrawTool",
	RectTool = "rectTool",
	EllipseTool = "ellipseTool",
	ArrowTool = "arrowTool",
	PenTool = "penTool",
	// HighlightTool = 'highlightTool',
	BlurTool = "blurTool",
	TextTool = "textTool",
	SerialNumberTool = "serialNumberTool",
	EraserTool = "eraserTool",
	UndoTool = "undoTool",
	RedoTool = "redoTool",
	CancelTool = "cancelTool",
	RemoveTool = "removeTool",
	ColorPickerCopy = "colorPickerCopy",
	SaveTool = "saveTool",
	FastSaveTool = "fastSaveTool",
	SaveToCloudTool = "saveToCloudTool",
	ScrollScreenshotTool = "scrollScreenshotTool",
	CopyTool = "copyTool",
	FixedTool = "fixedTool",
	OcrDetectTool = "ocrDetectTool",
	OcrTranslateTool = "ocrTranslateTool",
	ColorPickerMoveUp = "colorPickerMoveUp",
	ColorPickerMoveDown = "colorPickerMoveDown",
	ColorPickerMoveLeft = "colorPickerMoveLeft",
	ColorPickerMoveRight = "colorPickerMoveRight",
	ResizeFromCenterPicker = "resizeFromCenterPicker",
	SerialNumberDisableArrow = "serialNumberDisableArrow",
	MaintainAspectRatioPicker = "maintainAspectRatioPicker",
	RotateWithDiscreteAnglePicker = "rotateWithDiscreteAnglePicker",
	AutoAlignPicker = "autoAlignPicker",
	SwitchColorFormat = "switchColorFormat",
	SelectPrevRectTool = "selectPrevRectTool",
	LockWidthHeightPicker = "lockWidthHeightPicker",
	DragSelectRect = "dragSelectRect",
	PreviousCapture = "previousCapture",
	NextCapture = "nextCapture",
	LaserPointerTool = "laserPointerTool",
	ResetCanvasTool = "resetCanvasTool",
	OpenTranslationTool = "openTranslationTool",
}
