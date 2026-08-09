import type { ImageSharedBufferData } from "../../../tools";

export enum ColorPickerRenderMessageType {
	InitPreviewCanvas = "initPreviewCanvas",
	InitImageData = "initImageData",
	PutImageData = "putImageData",
	PickColor = "pickColor",
	GetPreviewImageData = "getPreviewImageData",
	SwitchCaptureHistory = "switchCaptureHistory",
}

export type ColorPickerRenderInitPreviewCanvasData = {
	type: ColorPickerRenderMessageType.InitPreviewCanvas;
	payload: {
		previewCanvas: OffscreenCanvas;
	};
};

export type ColorPickerRenderInitImageDataData = {
	type: ColorPickerRenderMessageType.InitImageData;
	payload: {
		imageBuffer: ArrayBuffer | ImageSharedBufferData;
	};
};

export type ColorPickerRenderPutImageDataData = {
	type: ColorPickerRenderMessageType.PutImageData;
	payload: {
		x: number;
		y: number;
		colorX: number;
		colorY: number;
		centerAuxiliaryLineColor: string | undefined;
	};
};

export type ColorPickerRenderPickColorData = {
	type: ColorPickerRenderMessageType.PickColor;
	payload: {
		x: number;
		y: number;
	};
};

export type ColorPickerRenderGetPreviewImageDataData = {
	type: ColorPickerRenderMessageType.GetPreviewImageData;
	payload: undefined;
};

export type ColorPickerRenderSwitchCaptureHistoryData = {
	type: ColorPickerRenderMessageType.SwitchCaptureHistory;
	payload: {
		imageSrc: string | undefined;
	};
};

export type ColorPickerRenderData =
	| ColorPickerRenderInitPreviewCanvasData
	| ColorPickerRenderInitImageDataData
	| ColorPickerRenderPutImageDataData
	| ColorPickerRenderPickColorData
	| ColorPickerRenderGetPreviewImageDataData
	| ColorPickerRenderSwitchCaptureHistoryData;

export type ColorPickerRenderInitPreviewCanvasResult = {
	type: ColorPickerRenderMessageType.InitPreviewCanvas;
	payload: undefined;
};

export type ColorPickerRenderInitImageDataResult = {
	type: ColorPickerRenderMessageType.InitImageData;
	payload: undefined;
};

export type ColorPickerRenderPutImageDataResult = {
	type: ColorPickerRenderMessageType.PutImageData;
	payload: {
		color: [red: number, green: number, blue: number];
	};
};

export type ColorPickerRenderPickColorResult = {
	type: ColorPickerRenderMessageType.PickColor;
	payload: {
		color: [red: number, green: number, blue: number];
	};
};

export type ColorPickerRenderGetPreviewImageDataResult = {
	type: ColorPickerRenderMessageType.GetPreviewImageData;
	payload: {
		imageData: ImageData | null;
	};
};

export type ColorPickerRenderSwitchCaptureHistoryResult = {
	type: ColorPickerRenderMessageType.SwitchCaptureHistory;
	payload: undefined;
};

export type ColorPickerRenderResult =
	| ColorPickerRenderInitPreviewCanvasResult
	| ColorPickerRenderInitImageDataResult
	| ColorPickerRenderPutImageDataResult
	| ColorPickerRenderPickColorResult
	| ColorPickerRenderGetPreviewImageDataResult
	| ColorPickerRenderSwitchCaptureHistoryResult;
