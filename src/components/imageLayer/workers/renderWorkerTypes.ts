import type * as PIXI from "pixi.js";
import type { ApplicationOptions } from "pixi.js";
import type { ImageSharedBufferData } from "@/pages/draw/tools";
import type { FixedContentProcessImageConfig } from "@/pages/fixedContent/components/fixedContentCore";
import type { ElementRect } from "@/types/commands/screenshot";
import type {
	BlurSpriteProps,
	HighlightElementProps,
	HighlightProps,
	WatermarkProps,
} from "../baseLayerRenderActions";

export type RefWrap<T> = {
	current: T;
};

export enum BaseLayerRenderMessageType {
	Init = "init",
	Dispose = "dispose",
	CreateNewCanvasContainer = "createNewCanvasContainer",
	ResizeCanvas = "resizeCanvas",
	ClearCanvas = "clearCanvas",
	GetImageBitmap = "getImageBitmap",
	RenderToCanvas = "renderToCanvas",
	RenderToPng = "renderToPng",
	CanvasRender = "canvasRender",
	AddImageToContainer = "addImageToContainer",
	ClearContainer = "clearContainer",
	CreateBlurSprite = "createBlurSprite",
	UpdateBlurSprite = "updateBlurSprite",
	UpdateWatermarkSprite = "updateWatermarkSprite",
	DeleteBlurSprite = "deleteBlurSprite",
	UpdateHighlightProps = "updateHighlightProps",
	UpdateHighlightElement = "updateHighlightElement",
	UpdateHighlight = "updateHighlight",
	ClearContext = "clearContext",
	TransferImageSharedBuffer = "transferImageSharedBuffer",
	InitBaseImageTexture = "initBaseImageTexture",
	ApplyProcessImageConfigToCanvas = "applyProcessImageConfigToCanvas",
	// worker 内部诊断日志转发（worker 的 console 不落盘，需转发到主线程由 appInfo/appWarn 落盘）
	ForwardLog = "forwardLog",
}

export type BaseLayerRenderInitData = {
	type: BaseLayerRenderMessageType.Init;
	payload: {
		appOptions: Partial<ApplicationOptions>;
	};
};

export type BaseLayerRenderDisposeData = {
	type: BaseLayerRenderMessageType.Dispose;
};

export type BaseLayerRenderCreateNewCanvasContainerData = {
	type: BaseLayerRenderMessageType.CreateNewCanvasContainer;
	payload: {
		containerKey: string;
	};
};

export type BaseLayerRenderResizeCanvasData = {
	type: BaseLayerRenderMessageType.ResizeCanvas;
	payload: {
		width: number;
		height: number;
	};
};

export type BaseLayerRenderClearCanvasData = {
	type: BaseLayerRenderMessageType.ClearCanvas;
};

export type BaseLayerRenderGetImageBitmapData = {
	type: BaseLayerRenderMessageType.GetImageBitmap;
	payload: {
		selectRect: ElementRect | undefined;
		imageContainerKey: string;
		renderContainerKey: string | undefined;
	};
};
export type BaseLayerRenderRenderToCanvasData = {
	type: BaseLayerRenderMessageType.RenderToCanvas;
	payload: {
		selectRect: ElementRect;
		imageContainerKey: string;
		containerId: string | undefined;
	};
};

export type BaseLayerRenderRenderToPngData = {
	type: BaseLayerRenderMessageType.RenderToPng;
	payload: {
		selectRect: ElementRect;
		imageContainerKey: string;
		containerId: string | undefined;
	};
};

export type BaseLayerRenderCanvasRenderData = {
	type: BaseLayerRenderMessageType.CanvasRender;
};

export type BaseLayerRenderAddImageToContainerData = {
	type: BaseLayerRenderMessageType.AddImageToContainer;
	payload: {
		containerKey: string;
		imageSrc:
			| string
			| ImageBitmap
			| ImageSharedBufferData
			| { type: "base_image_texture" }
			| { type: "shared_buffer_image_texture" };
		hideImageSprite?: boolean;
	};
};

export type BaseLayerRenderClearContainerData = {
	type: BaseLayerRenderMessageType.ClearContainer;
	payload: {
		containerKey: string;
	};
};

export type BaseLayerRenderCreateBlurSpriteData = {
	type: BaseLayerRenderMessageType.CreateBlurSprite;
	payload: {
		blurContainerKey: string;
		blurElementId: string;
		highlightContainerKey: string;
	};
};

export type BaseLayerRenderUpdateBlurSpriteData = {
	type: BaseLayerRenderMessageType.UpdateBlurSprite;
	payload: {
		blurElementId: string;
		blurProps: BlurSpriteProps;
		updateFilter: boolean;
		windowDevicePixelRatio: number;
	};
};

export type BaseLayerRenderUpdateWatermarkSpriteData = {
	type: BaseLayerRenderMessageType.UpdateWatermarkSprite;
	payload: {
		watermarkContainerKey: string;
		watermarkProps: WatermarkProps;
		textResolution: number;
	};
};

export type BaseLayerRenderDeleteBlurSpriteData = {
	type: BaseLayerRenderMessageType.DeleteBlurSprite;
	payload: {
		blurElementId: string;
	};
};

export type BaseLayerRenderUpdateHighlightElementData = {
	type: BaseLayerRenderMessageType.UpdateHighlightElement;
	payload: {
		highlightContainerKey: string;
		highlightElementId: string;
		highlightElementProps: HighlightElementProps | undefined;
		windowDevicePixelRatio: number;
	};
};

export type BaseLayerRenderUpdateHighlightData = {
	type: BaseLayerRenderMessageType.UpdateHighlight;
	payload: {
		highlightContainerKey: string;
		highlightProps: HighlightProps;
	};
};

export type BaseLayerRenderClearContextData = {
	type: BaseLayerRenderMessageType.ClearContext;
	payload: undefined;
};

export type BaseLayerRenderTransferImageSharedBufferData = {
	type: BaseLayerRenderMessageType.TransferImageSharedBuffer;
	payload: undefined;
};

export type BaseLayerRenderInitBaseImageTextureData = {
	type: BaseLayerRenderMessageType.InitBaseImageTexture;
	payload: {
		imageUrl: string;
	};
};

export type BaseLayerRenderApplyProcessImageConfigToCanvasData = {
	type: BaseLayerRenderMessageType.ApplyProcessImageConfigToCanvas;
	payload: {
		imageContainerKey: string;
		processImageConfig: FixedContentProcessImageConfig;
		canvasWidth: number;
		canvasHeight: number;
	};
};

// worker 诊断日志转发：主线程收到后调用 appInfo/appWarn 落盘
export type BaseLayerRenderForwardLogData = {
	type: BaseLayerRenderMessageType.ForwardLog;
	payload: {
		level: "info" | "warn" | "error";
		message: string;
	};
};

export type BaseLayerRenderData =
	| BaseLayerRenderInitData
	| BaseLayerRenderDisposeData
	| BaseLayerRenderCreateNewCanvasContainerData
	| BaseLayerRenderResizeCanvasData
	| BaseLayerRenderClearCanvasData
	| BaseLayerRenderGetImageBitmapData
	| BaseLayerRenderRenderToCanvasData
	| BaseLayerRenderRenderToPngData
	| BaseLayerRenderCanvasRenderData
	| BaseLayerRenderAddImageToContainerData
	| BaseLayerRenderClearContainerData
	| BaseLayerRenderCreateBlurSpriteData
	| BaseLayerRenderUpdateBlurSpriteData
	| BaseLayerRenderUpdateWatermarkSpriteData
	| BaseLayerRenderUpdateHighlightElementData
	| BaseLayerRenderDeleteBlurSpriteData
	| BaseLayerRenderUpdateHighlightElementData
	| BaseLayerRenderUpdateHighlightData
	| BaseLayerRenderClearContextData
	| BaseLayerRenderInitBaseImageTextureData
	| BaseLayerRenderTransferImageSharedBufferData
	| BaseLayerRenderApplyProcessImageConfigToCanvasData;

export type RenderInitResult = {
	type: BaseLayerRenderMessageType.Init;
	payload: OffscreenCanvas | HTMLCanvasElement | undefined;
};

export type RenderDisposeResult = {
	type: BaseLayerRenderMessageType.Dispose;
	payload: undefined;
};

export type RenderCreateNewCanvasContainerResult = {
	type: BaseLayerRenderMessageType.CreateNewCanvasContainer;
	payload: {
		containerKey: string | undefined;
	};
};

export type RenderResizeCanvasResult = {
	type: BaseLayerRenderMessageType.ResizeCanvas;
	payload: undefined;
};

export type RenderClearCanvasResult = {
	type: BaseLayerRenderMessageType.ClearCanvas;
	payload: undefined;
};

export type RenderGetImageBitmapResult = {
	type: BaseLayerRenderMessageType.GetImageBitmap;
	payload: {
		imageBitmap: ImageBitmap | undefined;
	};
};

export type RenderRenderToCanvasResult = {
	type: BaseLayerRenderMessageType.RenderToCanvas;
	payload: {
		canvas: PIXI.ICanvas | undefined;
	};
};

export type RenderRenderToPngResult = {
	type: BaseLayerRenderMessageType.RenderToPng;
	payload: {
		data: ArrayBuffer | undefined;
	};
};

export type RenderCanvasRenderResult = {
	type: BaseLayerRenderMessageType.CanvasRender;
	payload: undefined;
};

export type RenderAddImageToContainerResult = {
	type: BaseLayerRenderMessageType.AddImageToContainer;
	payload: undefined;
};

export type RenderClearContainerResult = {
	type: BaseLayerRenderMessageType.ClearContainer;
	payload: undefined;
};

export type RenderCreateBlurSpriteResult = {
	type: BaseLayerRenderMessageType.CreateBlurSprite;
	payload: undefined;
};

export type RenderUpdateBlurSpriteResult = {
	type: BaseLayerRenderMessageType.UpdateBlurSprite;
	payload: undefined;
};

export type RenderUpdateWatermarkSpriteResult = {
	type: BaseLayerRenderMessageType.UpdateWatermarkSprite;
	payload: undefined;
};

export type RenderDeleteBlurSpriteResult = {
	type: BaseLayerRenderMessageType.DeleteBlurSprite;
	payload: undefined;
};

export type RenderUpdateHighlightElementResult = {
	type: BaseLayerRenderMessageType.UpdateHighlightElement;
	payload: undefined;
};

export type RenderUpdateHighlightResult = {
	type: BaseLayerRenderMessageType.UpdateHighlight;
	payload: undefined;
};

export type RenderClearContextResult = {
	type: BaseLayerRenderMessageType.ClearContext;
	payload: undefined;
};

export type RenderInitBaseImageTextureResult = {
	type: BaseLayerRenderMessageType.InitBaseImageTexture;
	payload: {
		width: number;
		height: number;
	};
};

export type RenderApplyProcessImageConfigToCanvasResult = {
	type: BaseLayerRenderMessageType.ApplyProcessImageConfigToCanvas;
	payload: undefined;
};

export type RenderTransferImageSharedBufferResult = {
	type: BaseLayerRenderMessageType.TransferImageSharedBuffer;
	payload: {
		imageSharedBuffer: ImageSharedBufferData | undefined;
	};
};

export type RenderForwardLogResult = {
	type: BaseLayerRenderMessageType.ForwardLog;
	payload: undefined;
};

export type RenderBlurSpriteResult =
	| RenderCreateBlurSpriteResult
	| RenderUpdateBlurSpriteResult
	| RenderUpdateWatermarkSpriteResult
	| RenderDeleteBlurSpriteResult
	| RenderUpdateHighlightElementResult
	| RenderUpdateHighlightResult
	| RenderClearContextResult;

export type RenderResult =
	| RenderInitResult
	| RenderDisposeResult
	| RenderCreateNewCanvasContainerResult
	| RenderResizeCanvasResult
	| RenderClearCanvasResult
	| RenderGetImageBitmapResult
	| RenderRenderToCanvasResult
	| RenderRenderToPngResult
	| RenderCanvasRenderResult
	| RenderAddImageToContainerResult
	| RenderClearContainerResult
	| RenderBlurSpriteResult
	| RenderClearContainerResult
	| RenderUpdateWatermarkSpriteResult
	| RenderUpdateHighlightElementResult
	| RenderUpdateHighlightResult
	| RenderInitBaseImageTextureResult
	| RenderTransferImageSharedBufferResult
	| RenderApplyProcessImageConfigToCanvasResult
	| RenderForwardLogResult;
