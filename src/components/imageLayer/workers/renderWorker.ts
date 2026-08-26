import {
	type Application,
	type Container,
	DOMAdapter,
	type Filter,
	type Texture,
	WebWorkerAdapter,
} from "pixi.js";

DOMAdapter.set(WebWorkerAdapter);

import type { ImageSharedBufferData } from "@/pages/draw/tools";
import {
	type BlurSprite,
	type HighlightElement,
	renderAddImageToContainerAction,
	renderApplyProcessImageConfigToCanvasAction,
	renderCanvasRenderAction,
	renderClearCanvasAction,
	renderClearContainerAction,
	renderClearContextAction,
	renderCreateBlurSpriteAction,
	renderCreateNewCanvasContainerAction,
	renderDeleteBlurSpriteAction,
	renderDisposeCanvasAction,
	renderGetImageBitmapAction,
	renderInitBaseImageTextureAction,
	renderInitCanvasAction,
	renderRenderToCanvasAction,
	renderRenderToPngAction,
	renderResizeCanvasAction,
	renderTransferImageSharedBufferAction,
	renderUpdateBlurSpriteAction,
	renderUpdateHighlightAction,
	renderUpdateHighlightElementPropsAction,
	renderUpdateWatermarkSpriteAction,
	type WatermarkProps,
} from "../baseLayerRenderActions";
import {
	type BaseLayerRenderAddImageToContainerData,
	type BaseLayerRenderApplyProcessImageConfigToCanvasData,
	type BaseLayerRenderClearContainerData,
	type BaseLayerRenderCreateBlurSpriteData,
	type BaseLayerRenderCreateNewCanvasContainerData,
	type BaseLayerRenderData,
	type BaseLayerRenderDeleteBlurSpriteData,
	type BaseLayerRenderGetImageBitmapData,
	type BaseLayerRenderInitBaseImageTextureData,
	type BaseLayerRenderInitData,
	BaseLayerRenderMessageType,
	type BaseLayerRenderRenderToCanvasData,
	type BaseLayerRenderRenderToPngData,
	type BaseLayerRenderResizeCanvasData,
	type BaseLayerRenderUpdateBlurSpriteData,
	type BaseLayerRenderUpdateHighlightData,
	type BaseLayerRenderUpdateHighlightElementData,
	type BaseLayerRenderUpdateWatermarkSpriteData,
	type RefWrap,
	type RenderResult,
} from "./renderWorkerTypes";

const canvasAppRef: RefWrap<Application | undefined> = { current: undefined };
const baseImageTextureRef: RefWrap<Texture | undefined> = {
	current: undefined,
};
const sharedBufferImageTextureRef: RefWrap<Texture | undefined> = {
	current: undefined,
};
const imageSharedBufferRef: RefWrap<ImageSharedBufferData | undefined> = {
	current: undefined,
};
const canvasContainerMapRef: RefWrap<Map<string, Container>> = {
	current: new Map(),
};
// 不要使用 defaultWatermarkProps，避免编译异常
const lastWatermarkPropsRef: RefWrap<WatermarkProps> = {
	current: {
		fontSize: 0,
		color: "#000000",
		opacity: 0,
		visible: false,
		text: "",
		selectRectParams: {
			rect: {
				min_x: 0,
				min_y: 0,
				max_x: 0,
				max_y: 0,
			},
			radius: 0,
			shadowWidth: 0,
			shadowColor: "#000000",
		},
	},
};
const canvasContainerChildCountRef: RefWrap<number> = { current: 0 };
const currentImageTextureRef: RefWrap<Texture | undefined> = {
	current: undefined,
};
const blurSpriteMapRef: RefWrap<Map<string, BlurSprite>> = {
	current: new Map(),
};
const blurSpriteFilterMapRef: RefWrap<Map<string, Filter>> = {
	current: new Map(),
};
// 模糊精灵共享的扩展纹理缓存（用于避免边缘模糊采样到透明像素）
const paddedTextureRef: RefWrap<Texture | undefined> = {
	current: undefined,
};
const paddedTextureSourceRef: RefWrap<Texture | undefined> = {
	current: undefined,
};
const highlightElementMapRef: RefWrap<Map<string, HighlightElement>> = {
	current: new Map(),
};

const handleInit = async (data: BaseLayerRenderInitData) => {
	await renderInitCanvasAction(canvasAppRef, data.payload.appOptions);
};

const handleDispose = async () => {
	renderDisposeCanvasAction(canvasAppRef);
};

const handleCreateNewCanvasContainer = (
	data: BaseLayerRenderCreateNewCanvasContainerData,
): string | undefined => {
	return renderCreateNewCanvasContainerAction(
		canvasAppRef,
		canvasContainerMapRef,
		data.payload.containerKey,
	);
};

const handleResizeCanvas = (data: BaseLayerRenderResizeCanvasData) => {
	renderResizeCanvasAction(
		canvasAppRef,
		data.payload.width,
		data.payload.height,
	);
};

const handleClearCanvas = () => {
	renderClearCanvasAction(
		canvasAppRef,
		canvasContainerMapRef,
		canvasContainerChildCountRef,
		currentImageTextureRef,
		baseImageTextureRef,
		sharedBufferImageTextureRef,
		imageSharedBufferRef,
	);
};

const handleRenderToCanvas = (data: BaseLayerRenderRenderToCanvasData) => {
	return renderRenderToCanvasAction(
		canvasAppRef,
		canvasContainerMapRef,
		data.payload.imageContainerKey,
		data.payload.selectRect,
		data.payload.containerId,
	);
};

const handleCanvasRender = () => {
	renderCanvasRenderAction(canvasAppRef);
};

const handleAddImageToContainer = async (
	data: BaseLayerRenderAddImageToContainerData,
) => {
	await renderAddImageToContainerAction(
		canvasContainerMapRef,
		currentImageTextureRef,
		sharedBufferImageTextureRef,
		imageSharedBufferRef,
		baseImageTextureRef,
		data.payload.containerKey,
		data.payload.imageSrc,
		data.payload.hideImageSprite,
		blurSpriteMapRef,
	);
};

const handleClearContainer = (data: BaseLayerRenderClearContainerData) => {
	renderClearContainerAction(canvasContainerMapRef, data.payload.containerKey);
};

const handleCreateBlurSprite = (data: BaseLayerRenderCreateBlurSpriteData) => {
	renderCreateBlurSpriteAction(
		canvasAppRef,
		canvasContainerMapRef,
		currentImageTextureRef,
		blurSpriteMapRef,
		data.payload.blurContainerKey,
		data.payload.blurElementId,
		data.payload.highlightContainerKey,
		paddedTextureSourceRef,
		paddedTextureRef,
	);
};

const handleUpdateBlurSprite = (data: BaseLayerRenderUpdateBlurSpriteData) => {
	renderUpdateBlurSpriteAction(
		blurSpriteMapRef,
		blurSpriteFilterMapRef,
		data.payload.blurElementId,
		data.payload.blurProps,
		data.payload.updateFilter,
		data.payload.windowDevicePixelRatio,
	);
};

const handleDeleteBlurSprite = (data: BaseLayerRenderDeleteBlurSpriteData) => {
	renderDeleteBlurSpriteAction(blurSpriteMapRef, data.payload.blurElementId);
};

const handleUpdateHighlightElement = (
	data: BaseLayerRenderUpdateHighlightElementData,
) => {
	renderUpdateHighlightElementPropsAction(
		canvasContainerMapRef,
		currentImageTextureRef,
		highlightElementMapRef,
		data.payload.highlightContainerKey,
		data.payload.highlightElementId,
		data.payload.highlightElementProps,
		data.payload.windowDevicePixelRatio,
	);
};

const handleUpdateHighlight = (data: BaseLayerRenderUpdateHighlightData) => {
	renderUpdateHighlightAction(
		canvasAppRef,
		canvasContainerMapRef,
		highlightElementMapRef,
		blurSpriteMapRef,
		currentImageTextureRef,
		data.payload.highlightContainerKey,
		data.payload.highlightProps,
		paddedTextureSourceRef,
		paddedTextureRef,
	);
};

const handleUpdateWatermarkSprite = (
	data: BaseLayerRenderUpdateWatermarkSpriteData,
) => {
	renderUpdateWatermarkSpriteAction(
		canvasAppRef,
		canvasContainerMapRef,
		data.payload.watermarkContainerKey,
		lastWatermarkPropsRef,
		data.payload.watermarkProps,
		data.payload.textResolution,
	);
};

const handleClearContext = () => {
	renderClearContextAction(
		blurSpriteMapRef,
		blurSpriteFilterMapRef,
		highlightElementMapRef,
		lastWatermarkPropsRef,
		paddedTextureSourceRef,
		paddedTextureRef,
	);
};

const handleInitBaseImageTexture = (
	data: BaseLayerRenderInitBaseImageTextureData,
) => {
	return renderInitBaseImageTextureAction(
		baseImageTextureRef,
		data.payload.imageUrl,
	);
};

const handleRenderToPng = async (data: BaseLayerRenderRenderToPngData) => {
	return await renderRenderToPngAction(
		canvasAppRef,
		canvasContainerMapRef,
		data.payload.imageContainerKey,
		data.payload.selectRect,
		data.payload.containerId,
	);
};

const handleGetImageBitmap = async (
	data: BaseLayerRenderGetImageBitmapData,
) => {
	return await renderGetImageBitmapAction(
		canvasAppRef,
		canvasContainerMapRef,
		data.payload.imageContainerKey,
		data.payload.selectRect,
		data.payload.renderContainerKey,
	);
};

const handleTransferImageSharedBuffer = () => {
	return renderTransferImageSharedBufferAction(imageSharedBufferRef);
};

const handleApplyProcessImageConfigToCanvas = (
	data: BaseLayerRenderApplyProcessImageConfigToCanvasData,
) => {
	renderApplyProcessImageConfigToCanvasAction(
		canvasAppRef,
		canvasContainerMapRef,
		blurSpriteMapRef,
		currentImageTextureRef,
		data.payload.imageContainerKey,
		data.payload.processImageConfig,
		data.payload.canvasWidth,
		data.payload.canvasHeight,
		paddedTextureSourceRef,
		paddedTextureRef,
	);
};

self.onmessage = async ({ data }: MessageEvent<BaseLayerRenderData>) => {
	let message: RenderResult;

	switch (data.type) {
		case BaseLayerRenderMessageType.Init:
			await handleInit(data);
			message = {
				type: BaseLayerRenderMessageType.Init,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.Dispose:
			await handleDispose();
			message = {
				type: BaseLayerRenderMessageType.Dispose,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.CreateNewCanvasContainer: {
			const containerKey = handleCreateNewCanvasContainer(data);
			message = {
				type: BaseLayerRenderMessageType.CreateNewCanvasContainer,
				payload: { containerKey },
			};
			break;
		}
		case BaseLayerRenderMessageType.ResizeCanvas:
			handleResizeCanvas(data);
			message = {
				type: BaseLayerRenderMessageType.ResizeCanvas,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.ClearCanvas: {
			handleClearCanvas();
			message = {
				type: BaseLayerRenderMessageType.ClearCanvas,
				payload: undefined,
			};
			break;
		}
		case BaseLayerRenderMessageType.RenderToCanvas: {
			const canvas = handleRenderToCanvas(data);
			message = {
				type: BaseLayerRenderMessageType.RenderToCanvas,
				payload: { canvas },
			};
			// 使用 transferable objects 传输 OffscreenCanvas，避免性能开销
			if (canvas && canvas instanceof OffscreenCanvas) {
				self.postMessage(message, { transfer: [canvas] });
				return;
			}
			break;
		}
		case BaseLayerRenderMessageType.CanvasRender:
			handleCanvasRender();
			message = {
				type: BaseLayerRenderMessageType.CanvasRender,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.AddImageToContainer:
			await handleAddImageToContainer(data);
			message = {
				type: BaseLayerRenderMessageType.AddImageToContainer,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.ClearContainer:
			handleClearContainer(data);
			message = {
				type: BaseLayerRenderMessageType.ClearContainer,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.CreateBlurSprite:
			handleCreateBlurSprite(data);
			message = {
				type: BaseLayerRenderMessageType.CreateBlurSprite,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.UpdateBlurSprite:
			handleUpdateBlurSprite(data);
			message = {
				type: BaseLayerRenderMessageType.UpdateBlurSprite,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.DeleteBlurSprite:
			handleDeleteBlurSprite(data);
			message = {
				type: BaseLayerRenderMessageType.DeleteBlurSprite,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.UpdateWatermarkSprite:
			handleUpdateWatermarkSprite(data);
			message = {
				type: BaseLayerRenderMessageType.UpdateWatermarkSprite,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.UpdateHighlightElement:
			handleUpdateHighlightElement(data);
			message = {
				type: BaseLayerRenderMessageType.UpdateHighlightElement,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.UpdateHighlight:
			handleUpdateHighlight(data);
			message = {
				type: BaseLayerRenderMessageType.UpdateHighlight,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.ClearContext:
			handleClearContext();
			message = {
				type: BaseLayerRenderMessageType.ClearContext,
				payload: undefined,
			};
			break;
		case BaseLayerRenderMessageType.InitBaseImageTexture: {
			const result = await handleInitBaseImageTexture(data);
			message = {
				type: BaseLayerRenderMessageType.InitBaseImageTexture,
				payload: result,
			};
			break;
		}
		case BaseLayerRenderMessageType.RenderToPng: {
			const result = await handleRenderToPng(data);
			message = {
				type: BaseLayerRenderMessageType.RenderToPng,
				payload: { data: result },
			};
			// 使用 transferable objects 传输 ArrayBuffer，避免性能开销
			if (result) {
				self.postMessage(message, { transfer: [result] });
				return;
			}
			break;
		}
		case BaseLayerRenderMessageType.GetImageBitmap: {
			const result = await handleGetImageBitmap(data);
			message = {
				type: BaseLayerRenderMessageType.GetImageBitmap,
				payload: { imageBitmap: result },
			};
			// 使用 transferable objects 实现零拷贝传输 ImageBitmap，避免性能开销
			if (result) {
				self.postMessage(message, { transfer: [result] });
				return;
			}
			break;
		}
		case BaseLayerRenderMessageType.TransferImageSharedBuffer: {
			const result = handleTransferImageSharedBuffer();
			message = {
				type: BaseLayerRenderMessageType.TransferImageSharedBuffer,
				payload: { imageSharedBuffer: result },
			};
			if (result) {
				self.postMessage(message, { transfer: [result.sharedBuffer.buffer] });
				return;
			}
			break;
		}
		case BaseLayerRenderMessageType.ApplyProcessImageConfigToCanvas: {
			handleApplyProcessImageConfigToCanvas(data);
			message = {
				type: BaseLayerRenderMessageType.ApplyProcessImageConfigToCanvas,
				payload: undefined,
			};
			break;
		}
	}

	self.postMessage(message);
};
