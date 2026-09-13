/** 画布工具栏标识 */
export enum ToolbarId {
	/** 主截图工具栏 */
	Main = "main",
	/** 全屏绘制工具栏 */
	FullScreen = "fullScreen",
	/** 贴图工具栏 */
	FixedContent = "fixedContent",
}

/**
 * 画布工具栏工具的稳定标识。
 * 不能直接使用 DrawState：主工具栏的"转到翻译页"与全屏工具栏的"激光笔"
 * 共用 DrawState.LaserPointer，贴图工具栏的裁剪按钮没有对应 DrawState。
 *
 * 组合（Popover）不再是固定的"组合工具"键，而是布局数据：
 * `toolbarGroups[head] = members`，head 与成员都是这里的一等工具键。
 */
export enum ToolbarToolKey {
	// —— 顶层工具（可排序、可隐藏）——
	/** 移动 */
	MoveTool = "moveTool",
	/** 选择 */
	SelectTool = "selectTool",
	/** 锁定绘制 */
	LockTool = "lockTool",
	/** 矩形 */
	RectTool = "rectTool",
	/** 菱形 */
	DiamondTool = "diamondTool",
	/** 椭圆 */
	EllipseTool = "ellipseTool",
	/** 箭头 */
	ArrowTool = "arrowTool",
	/** 直线 */
	LineTool = "lineTool",
	/** 画笔 */
	PenTool = "penTool",
	/** 文字 */
	TextTool = "textTool",
	/** 序列号 */
	SerialNumberTool = "serialNumberTool",
	/** 滤镜 */
	BlurTool = "blurTool",
	/** 滤镜绘制 */
	BlurFreeDrawTool = "blurFreeDrawTool",
	/** 橡皮擦 */
	EraserTool = "eraserTool",
	/** 水印 */
	WatermarkTool = "watermarkTool",
	/** 高亮 */
	HighlightTool = "highlightTool",
	/** 撤销 / 重做 */
	HistoryTool = "historyTool",
	/** 扫描二维码 */
	ScanQrcodeTool = "scanQrcodeTool",
	/** 视频录制 */
	VideoRecordTool = "videoRecordTool",
	/** 截图并贴图 */
	FixedTool = "fixedTool",
	/** 文本识别 */
	OcrDetectTool = "ocrDetectTool",
	/** 文本识别翻译 */
	OcrTranslateTool = "ocrTranslateTool",
	/** 转到翻译页 */
	OpenTranslationTool = "openTranslationTool",
	/** 滚动截图 */
	ScrollScreenshotTool = "scrollScreenshotTool",
	/** 快速保存 */
	FastSaveTool = "fastSaveTool",
	/** 保存到云端 */
	SaveToCloudTool = "saveToCloudTool",
	/** 保存为文件 */
	SaveTool = "saveTool",
	/** 取消 */
	CancelTool = "cancelTool",
	/** 复制到剪贴板 */
	CopyTool = "copyTool",
	/** 激光笔（全屏工具栏） */
	LaserPointerTool = "laserPointerTool",
	/** 重置画布（全屏工具栏） */
	ResetCanvasTool = "resetCanvasTool",
	/** 鼠标穿透（全屏工具栏） */
	MouseThroughTool = "mouseThroughTool",
	/** 裁剪（贴图工具栏） */
	CropTool = "cropTool",
	/** 确认（贴图工具栏） */
	ConfirmTool = "confirmTool",
}

/** 工具隐藏状态表，键为 ToolbarToolKey */
export type ToolbarToolHiddenMap = Partial<Record<ToolbarToolKey, boolean>>;

/** 组合成员表：head（在 order 中的键）→ 成员键列表（不含 head 自身） */
export type ToolbarGroupsMap = Partial<
	Record<ToolbarToolKey, ToolbarToolKey[]>
>;
