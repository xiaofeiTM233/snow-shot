import type {
	Application,
	ApplicationOptions,
	Container,
	Filter,
	ICanvas,
	Texture,
} from "pixi.js";
import type { RefObject } from "react";
import type { ImageSharedBufferData } from "@/pages/draw/tools";
import type { FixedContentProcessImageConfig } from "@/pages/fixedContent/components/fixedContentCore";
import type { ElementRect } from "@/types/commands/screenshot";
import { appDebug, appWarn } from "@/utils/log";
import {
	type BlurSprite,
	type BlurSpriteProps,
	type HighlightElement,
	type HighlightElementProps,
	type HighlightProps,
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
	renderEnsureImageRenderedAction,
	type ContextRestoreRefs,
	type WatermarkProps,
} from "./baseLayerRenderActions";
import {
	type BaseLayerRenderAddImageToContainerData,
	type BaseLayerRenderApplyProcessImageConfigToCanvasData,
	type BaseLayerRenderCanvasRenderData,
	type BaseLayerRenderClearCanvasData,
	type BaseLayerRenderClearContainerData,
	type BaseLayerRenderClearContextData,
	type BaseLayerRenderCreateBlurSpriteData,
	type BaseLayerRenderCreateNewCanvasContainerData,
	type BaseLayerRenderDeleteBlurSpriteData,
	type BaseLayerRenderDisposeData,
	type BaseLayerRenderEnsureImageRenderedData,
	type BaseLayerRenderGetImageBitmapData,
	type BaseLayerRenderInitBaseImageTextureData,
	type BaseLayerRenderInitData,
	BaseLayerRenderMessageType,
	type BaseLayerRenderRenderToCanvasData,
	type BaseLayerRenderRenderToPngData,
	type BaseLayerRenderResizeCanvasData,
	type BaseLayerRenderTransferImageSharedBufferData,
	type BaseLayerRenderUpdateBlurSpriteData,
	type BaseLayerRenderUpdateHighlightData,
	type BaseLayerRenderUpdateHighlightElementData,
	type BaseLayerRenderUpdateWatermarkSpriteData,
	type RenderResult,
} from "./workers/renderWorkerTypes";

// 截图主容器 key：定义移至 baseLayerRenderActions（渲染层内部需要），此处 re-export 保持兼容
export { INIT_CONTAINER_KEY } from "./baseLayerRenderActions";

/**
 * 黑屏兜底：让 worker 检查截图容器是否已渲染，空则用主线程持有的 sharedBuffer
 * 拷贝重新渲染。返回容器 children 数量（> 0 表示渲染正常）。
 */
export const ensureImageRenderedAction = async (
	renderWorker: Worker | undefined,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	currentImageTextureRef: RefObject<Texture | undefined>,
	sharedBufferImageTextureRef: RefObject<Texture | undefined>,
	imageSharedBufferRef: RefObject<ImageSharedBufferData | undefined>,
	baseImageTextureRef: RefObject<Texture | undefined>,
	blurSpriteMapRef: RefObject<Map<string, BlurSprite>>,
	containerKey: string,
	fallbackImageBuffer: ImageSharedBufferData | undefined,
): Promise<number> => {
	/**
	 * 两步查询，避免无条件 transfer 破坏主线程兜底拷贝：
	 * 1) 先发不带 buffer 的检查请求，拿容器 children 数；
	 *    （此路径绝不 transfer，保证 capturedSharedBufferRef 数据完好）
	 * 2) 仅当容器为空（childrenCount === 0）且兜底 buffer 有效时，
	 *    才发第二次请求（带 buffer transfer）触发重新渲染。
	 * 附 3 秒超时保护，防止 worker 无响应导致 readyCapture 卡死。
	 */
	const queryOnce = (
		withBuffer: boolean,
	): Promise<number | undefined> => {
		return new Promise((resolve) => {
			if (!renderWorker) {
				resolve(undefined);
				return;
			}
			const timeout = setTimeout(() => {
				renderWorker.removeEventListener("message", handleMessage);
				resolve(undefined);
			}, 3000);

			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.EnsureImageRendered) {
					clearTimeout(timeout);
					renderWorker.removeEventListener("message", handleMessage);
					resolve(payload.childrenCount);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const bufferToSend = withBuffer ? fallbackImageBuffer : undefined;
			const EnsureImageRenderedData: BaseLayerRenderEnsureImageRenderedData =
				{
					type: BaseLayerRenderMessageType.EnsureImageRendered,
					payload: {
						containerKey,
						imageBuffer: bufferToSend,
					},
				};

			if (
				bufferToSend &&
				bufferToSend.sharedBuffer?.buffer &&
				bufferToSend.sharedBuffer.buffer.byteLength > 0
			) {
				renderWorker.postMessage(EnsureImageRenderedData, {
					transfer: [bufferToSend.sharedBuffer.buffer],
				});
			} else {
				renderWorker.postMessage(EnsureImageRenderedData);
			}
		});
	};

	if (!renderWorker) {
		return renderEnsureImageRenderedAction(
			canvasContainerMapRef,
			currentImageTextureRef,
			sharedBufferImageTextureRef,
			imageSharedBufferRef,
			baseImageTextureRef,
			blurSpriteMapRef,
			containerKey,
			fallbackImageBuffer,
		);
	}

	// 第一步：只查状态，不 transfer 任何数据
	const initialCount = await queryOnce(false);
	if (initialCount === undefined) {
		// 超时/异常，视作容器可能异常，但不消耗兜底数据
		return 0;
	}
	if (initialCount > 0) {
		return initialCount;
	}

	// 第二步：容器确认为空，才用兜底 buffer（transfer）重新渲染
	const fallbackCount = await queryOnce(true);
	return fallbackCount ?? 0;
};

export const initCanvasAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	appOptions: Partial<ApplicationOptions>,
	transfer: Transferable[] | undefined,
	contextRestoreRefs?: ContextRestoreRefs,
): Promise<OffscreenCanvas | HTMLCanvasElement | undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			let settled = false;
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				if (settled) {
					return;
				}
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.Init) {
					settled = true;
					clearTimeout(timeoutId);
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			// 超时兜底：worker init 挂起/异常未回传 result 时（实测 WebGPU init
			// 在 worker 环境挂起发生过），防止主线程初始化流程永久卡死。
			// worker 侧 WebGPU init 超时 15s 后回退 WebGL，这里留 30s 余量
			const timeoutId = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				appWarn(
					"[ImageLayer][initCanvasAction] renderer worker init timeout (30s), giving up waiting for Init result",
				);
				resolve(undefined);
				renderWorker.removeEventListener("message", handleMessage);
			}, 30_000);

			const InitData: BaseLayerRenderInitData = {
				type: BaseLayerRenderMessageType.Init,
				payload: {
					appOptions,
				},
			};

			if (transfer) {
				renderWorker.postMessage(InitData, transfer);
			} else {
				renderWorker.postMessage(InitData);
			}
		} else {
			renderInitCanvasAction(canvasAppRef, appOptions, contextRestoreRefs).then(
				(canvas) => {
					resolve(canvas);
				},
			);
		}
	});
};

export const disposeCanvasAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.Dispose) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const DisposeData: BaseLayerRenderDisposeData = {
				type: BaseLayerRenderMessageType.Dispose,
			};

			renderWorker.postMessage(DisposeData);
		} else {
			renderDisposeCanvasAction(canvasAppRef);
			resolve(undefined);
		}
	});
};

export const initBaseImageTextureAction = async (
	renderWorker: Worker | undefined,
	baseImageTextureRef: RefObject<Texture | undefined>,
	imageUrl: string,
): Promise<{ width: number; height: number }> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.InitBaseImageTexture) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const InitBaseImageTextureData: BaseLayerRenderInitBaseImageTextureData =
				{
					type: BaseLayerRenderMessageType.InitBaseImageTexture,
					payload: {
						imageUrl: imageUrl,
					},
				};

			renderWorker.postMessage(InitBaseImageTextureData);
		} else {
			const result = renderInitBaseImageTextureAction(
				baseImageTextureRef,
				imageUrl,
			);
			resolve(result);
		}
	});
};

export const createNewCanvasContainerAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	canvasContainerListRef: RefObject<Map<string, Container>>,
	containerKey: string,
): Promise<string | undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.CreateNewCanvasContainer) {
					resolve(payload.containerKey);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const CreateNewCanvasContainerData: BaseLayerRenderCreateNewCanvasContainerData =
				{
					type: BaseLayerRenderMessageType.CreateNewCanvasContainer,
					payload: {
						containerKey: containerKey,
					},
				};

			renderWorker.postMessage(CreateNewCanvasContainerData);
		} else {
			const result = renderCreateNewCanvasContainerAction(
				canvasAppRef,
				canvasContainerListRef,
				containerKey,
			);
			resolve(result);
		}
	});
};

export const resizeCanvasAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	width: number,
	height: number,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.ResizeCanvas) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const ResizeCanvasData: BaseLayerRenderResizeCanvasData = {
				type: BaseLayerRenderMessageType.ResizeCanvas,
				payload: {
					width: width,
					height: height,
				},
			};

			renderWorker.postMessage(ResizeCanvasData);
		} else {
			renderResizeCanvasAction(canvasAppRef, width, height);
			resolve(undefined);
		}
	});
};

export const clearCanvasAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	canvasContainerChildCountRef: RefObject<number>,
	currentImageTextureRef: RefObject<Texture | undefined>,
	baseImageTextureRef: RefObject<Texture | undefined>,
	sharedBufferImageTextureRef?: RefObject<Texture | undefined>,
	imageSharedBufferRef?: RefObject<ImageSharedBufferData | undefined>,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.ClearCanvas) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const ClearCanvasData: BaseLayerRenderClearCanvasData = {
				type: BaseLayerRenderMessageType.ClearCanvas,
			};

			renderWorker.postMessage(ClearCanvasData);
		} else {
			renderClearCanvasAction(
				canvasAppRef,
				canvasContainerMapRef,
				canvasContainerChildCountRef,
				currentImageTextureRef,
				baseImageTextureRef,
				sharedBufferImageTextureRef,
				imageSharedBufferRef,
			);
			resolve(undefined);
		}
	});
};

export const renderToCanvasAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	imageContainerKey: string,
	selectRect: ElementRect,
	containerId: string | undefined,
): Promise<ICanvas | undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.RenderToCanvas) {
					resolve(payload.canvas);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const RenderToCanvasData: BaseLayerRenderRenderToCanvasData = {
				type: BaseLayerRenderMessageType.RenderToCanvas,
				payload: {
					imageContainerKey: imageContainerKey,
					selectRect: selectRect,
					containerId: containerId,
				},
			};

			renderWorker.postMessage(RenderToCanvasData);
		} else {
			const result = renderRenderToCanvasAction(
				canvasAppRef,
				canvasContainerMapRef,
				imageContainerKey,
				selectRect,
				containerId,
			);
			resolve(result);
		}
	});
};

export const renderToPngAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	imageContainerKey: string,
	selectRect: ElementRect,
	containerId: string | undefined,
): Promise<ArrayBuffer | undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.RenderToPng) {
					resolve(payload.data);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const RenderToPngData: BaseLayerRenderRenderToPngData = {
				type: BaseLayerRenderMessageType.RenderToPng,
				payload: {
					selectRect: selectRect,
					imageContainerKey: imageContainerKey,
					containerId: containerId,
				},
			};

			renderWorker.postMessage(RenderToPngData);
		} else {
			renderRenderToPngAction(
				canvasAppRef,
				canvasContainerMapRef,
				imageContainerKey,
				selectRect,
				containerId,
			).then(resolve);
		}
	});
};

export const getImageBitmapAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	imageContainerKey: string,
	selectRect: ElementRect | undefined,
	renderContainerKey: string | undefined,
): Promise<ImageBitmap | undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.GetImageBitmap) {
					resolve(payload.imageBitmap);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const GetImageBitmapData: BaseLayerRenderGetImageBitmapData = {
				type: BaseLayerRenderMessageType.GetImageBitmap,
				payload: {
					selectRect: selectRect,
					imageContainerKey: imageContainerKey,
					renderContainerKey: renderContainerKey,
				},
			};

			renderWorker.postMessage(GetImageBitmapData);
		} else {
			renderGetImageBitmapAction(
				canvasAppRef,
				canvasContainerMapRef,
				imageContainerKey,
				selectRect,
				renderContainerKey,
			).then(resolve);
		}
	});
};

export const canvasRenderAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.CanvasRender) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const CanvasRenderData: BaseLayerRenderCanvasRenderData = {
				type: BaseLayerRenderMessageType.CanvasRender,
			};

			renderWorker.postMessage(CanvasRenderData);
		} else {
			renderCanvasRenderAction(canvasAppRef);
			resolve(undefined);
		}
	});
};

export const addImageToContainerAction = async (
	renderWorker: Worker | undefined,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	currentImageTextureRef: RefObject<Texture | undefined>,
	sharedBufferImageTextureRef: RefObject<Texture | undefined>,
	imageSharedBufferRef: RefObject<ImageSharedBufferData | undefined>,
	baseImageTextureRef: RefObject<Texture | undefined>,
	blurSpriteMapRef: RefObject<Map<string, BlurSprite>>,
	containerKey: string,
	imageSrc:
		| string
		| ImageBitmap
		| ImageSharedBufferData
		| { type: "base_image_texture" }
		| { type: "shared_buffer_image_texture" },
	hideImageSprite?: boolean,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.AddImageToContainer) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			const AddImageToContainerData: BaseLayerRenderAddImageToContainerData = {
				type: BaseLayerRenderMessageType.AddImageToContainer,
				payload: {
					containerKey: containerKey,
					imageSrc: imageSrc,
					hideImageSprite: hideImageSprite,
				},
			};

			if (
				typeof imageSrc === "object" &&
				"sharedBuffer" in imageSrc &&
				imageSrc.sharedBuffer?.buffer
			) {
				if (imageSrc.sharedBuffer.buffer.byteLength > 0) {
					appDebug(
						`[ImageLayer][addImageToContainerAction] transfer real sharedBuffer to worker, byteLength: ${imageSrc.sharedBuffer.buffer.byteLength}`,
					);
					renderWorker.postMessage(AddImageToContainerData, {
						transfer: [imageSrc.sharedBuffer.buffer],
					});
				} else {
					// SharedBuffer 已经传递给了 Worker，传递标记给 Worker 使用，避免报错
					appDebug(
						"[ImageLayer][addImageToContainerAction] sharedBuffer buffer is EMPTY (byteLength 0), using cached texture in worker",
					);
					AddImageToContainerData.payload.imageSrc = {
						type: "shared_buffer_image_texture",
					};
					renderWorker.postMessage(AddImageToContainerData);
				}
			} else if (imageSrc instanceof ImageBitmap) {
				renderWorker.postMessage(AddImageToContainerData, {
					transfer: [imageSrc],
				});
			} else {
				appDebug(
					`[ImageLayer][addImageToContainerAction] non-sharedBuffer path, imageSrc: ${JSON.stringify(imageSrc)?.slice(0, 80)}`,
				);
				renderWorker.postMessage(AddImageToContainerData);
			}
		} else {
			renderAddImageToContainerAction(
				canvasContainerMapRef,
				currentImageTextureRef,
				sharedBufferImageTextureRef,
				imageSharedBufferRef,
				baseImageTextureRef,
				containerKey,
				imageSrc,
				hideImageSprite,
				blurSpriteMapRef,
			).then(() => resolve(undefined));
		}
	});
};

export const clearContainerAction = async (
	renderWorker: Worker | undefined,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	containerKey: string,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const ClearContainerData: BaseLayerRenderClearContainerData = {
				type: BaseLayerRenderMessageType.ClearContainer,
				payload: {
					containerKey: containerKey,
				},
			};
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.ClearContainer) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(ClearContainerData);
		} else {
			renderClearContainerAction(canvasContainerMapRef, containerKey);
			resolve(undefined);
		}
	});
};

export const createBlurSpriteAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	currentImageTextureRef: RefObject<Texture | undefined>,
	blurSpriteMapRef: RefObject<Map<string, BlurSprite>>,
	blurContainerKey: string,
	blurElementId: string,
	highlightContainerKey: string,
	paddedTextureSourceRef: RefObject<Texture | undefined>,
	paddedTextureRef: RefObject<Texture | undefined>,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const CreateBlurSpriteData: BaseLayerRenderCreateBlurSpriteData = {
				type: BaseLayerRenderMessageType.CreateBlurSprite,
				payload: {
					blurContainerKey: blurContainerKey,
					blurElementId: blurElementId,
					highlightContainerKey: highlightContainerKey,
				},
			};
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.CreateBlurSprite) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(CreateBlurSpriteData);
		} else {
			renderCreateBlurSpriteAction(
				canvasAppRef,
				canvasContainerMapRef,
				currentImageTextureRef,
				blurSpriteMapRef,
				blurContainerKey,
				blurElementId,
				highlightContainerKey,
				paddedTextureSourceRef,
				paddedTextureRef,
			);
			resolve(undefined);
		}
	});
};

export const updateBlurSpriteAction = async (
	renderWorker: Worker | undefined,
	blurSpriteMapRef: RefObject<Map<string, BlurSprite>>,
	blurSpriteFilterMapRef: RefObject<Map<string, Filter>>,
	blurElementId: string,
	blurProps: BlurSpriteProps,
	updateFilter: boolean,
	windowDevicePixelRatio: number,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const UpdateBlurSpriteData: BaseLayerRenderUpdateBlurSpriteData = {
				type: BaseLayerRenderMessageType.UpdateBlurSprite,
				payload: {
					blurElementId: blurElementId,
					blurProps: blurProps,
					updateFilter: updateFilter,
					windowDevicePixelRatio: windowDevicePixelRatio,
				},
			};
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.UpdateBlurSprite) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(UpdateBlurSpriteData);
		} else {
			renderUpdateBlurSpriteAction(
				blurSpriteMapRef,
				blurSpriteFilterMapRef,
				blurElementId,
				blurProps,
				updateFilter,
				windowDevicePixelRatio,
			);
			resolve(undefined);
		}
	});
};

export const deleteBlurSpriteAction = async (
	renderWorker: Worker | undefined,
	blurSpriteMapRef: RefObject<Map<string, BlurSprite>>,
	blurElementId: string,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const DeleteBlurSpriteData: BaseLayerRenderDeleteBlurSpriteData = {
				type: BaseLayerRenderMessageType.DeleteBlurSprite,
				payload: {
					blurElementId: blurElementId,
				},
			};
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.DeleteBlurSprite) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(DeleteBlurSpriteData);
		} else {
			renderDeleteBlurSpriteAction(blurSpriteMapRef, blurElementId);
			resolve(undefined);
		}
	});
};

export const updateWatermarkSpriteAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	lastWatermarkPropsRef: RefObject<WatermarkProps>,
	watermarkContainerKey: string,
	watermarkProps: WatermarkProps,
	textResolution: number,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const UpdateWatermarkSpriteData: BaseLayerRenderUpdateWatermarkSpriteData =
				{
					type: BaseLayerRenderMessageType.UpdateWatermarkSprite,
					payload: {
						watermarkContainerKey: watermarkContainerKey,
						watermarkProps: watermarkProps,
						textResolution: textResolution,
					},
				};
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.UpdateWatermarkSprite) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(UpdateWatermarkSpriteData);
		} else {
			renderUpdateWatermarkSpriteAction(
				canvasAppRef,
				canvasContainerMapRef,
				watermarkContainerKey,
				lastWatermarkPropsRef,
				watermarkProps,
				textResolution,
			);
			resolve(undefined);
		}
	});
};

export const updateHighlightElementAction = async (
	renderWorker: Worker | undefined,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	currentImageTextureRef: RefObject<Texture | undefined>,
	highlightElementMapRef: RefObject<Map<string, HighlightElement>>,
	highlightContainerKey: string,
	highlightElementId: string,
	highlightElementProps: HighlightElementProps | undefined,
	windowDevicePixelRatio: number,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const UpdateHighlightElementData: BaseLayerRenderUpdateHighlightElementData =
				{
					type: BaseLayerRenderMessageType.UpdateHighlightElement,
					payload: {
						highlightContainerKey: highlightContainerKey,
						highlightElementId: highlightElementId,
						highlightElementProps: highlightElementProps,
						windowDevicePixelRatio: windowDevicePixelRatio,
					},
				};
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.UpdateHighlightElement) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(UpdateHighlightElementData);
		} else {
			renderUpdateHighlightElementPropsAction(
				canvasContainerMapRef,
				currentImageTextureRef,
				highlightElementMapRef,
				highlightContainerKey,
				highlightElementId,
				highlightElementProps,
				windowDevicePixelRatio,
			);
			resolve(undefined);
		}
	});
};

export const updateHighlightAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	highlightElementMapRef: RefObject<Map<string, HighlightElement>>,
	blurSpriteMapRef: RefObject<Map<string, BlurSprite>>,
	currentImageTextureRef: RefObject<Texture | undefined>,
	highlightContainerKey: string,
	highlightProps: HighlightProps,
	paddedTextureSourceRef: RefObject<Texture | undefined>,
	paddedTextureRef: RefObject<Texture | undefined>,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const UpdateHighlightData: BaseLayerRenderUpdateHighlightData = {
				type: BaseLayerRenderMessageType.UpdateHighlight,
				payload: {
					highlightContainerKey: highlightContainerKey,
					highlightProps: highlightProps,
				},
			};
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.UpdateHighlight) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(UpdateHighlightData);
		} else {
			renderUpdateHighlightAction(
				canvasAppRef,
				canvasContainerMapRef,
				highlightElementMapRef,
				blurSpriteMapRef,
				currentImageTextureRef,
				highlightContainerKey,
				highlightProps,
				paddedTextureSourceRef,
				paddedTextureRef,
			);
			resolve(undefined);
		}
	});
};

export const clearContextAction = async (
	renderWorker: Worker | undefined,
	blurSpriteMapRef: RefObject<Map<string, BlurSprite>>,
	blurSpriteFilterMapRef: RefObject<Map<string, Filter>>,
	highlightElementMapRef: RefObject<Map<string, HighlightElement>>,
	lastWatermarkPropsRef: RefObject<WatermarkProps>,
	paddedTextureSourceRef: RefObject<Texture | undefined>,
	paddedTextureRef: RefObject<Texture | undefined>,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const ClearContextData: BaseLayerRenderClearContextData = {
				type: BaseLayerRenderMessageType.ClearContext,
				payload: undefined,
			};
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.ClearContext) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(ClearContextData);
		} else {
			renderClearContextAction(
				blurSpriteMapRef,
				blurSpriteFilterMapRef,
				highlightElementMapRef,
				lastWatermarkPropsRef,
				paddedTextureSourceRef,
				paddedTextureRef,
			);
			resolve(undefined);
		}
	});
};

export const transferImageSharedBufferAction = async (
	renderWorker: Worker | undefined,
	imageSharedBufferRef: RefObject<ImageSharedBufferData | undefined>,
): Promise<ImageSharedBufferData | undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const TransferImageSharedBufferData: BaseLayerRenderTransferImageSharedBufferData =
				{
					type: BaseLayerRenderMessageType.TransferImageSharedBuffer,
					payload: undefined,
				};
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (type === BaseLayerRenderMessageType.TransferImageSharedBuffer) {
					resolve(payload.imageSharedBuffer);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};

			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(TransferImageSharedBufferData);
		} else {
			const result =
				renderTransferImageSharedBufferAction(imageSharedBufferRef);
			resolve(result);
		}
	});
};

export const applyProcessImageConfigToCanvasAction = async (
	renderWorker: Worker | undefined,
	canvasAppRef: RefObject<Application | undefined>,
	canvasContainerMapRef: RefObject<Map<string, Container>>,
	blurSpriteMapRef: RefObject<Map<string, BlurSprite>>,
	currentImageTextureRef: RefObject<Texture | undefined>,
	imageContainerKey: string,
	processImageConfig: FixedContentProcessImageConfig,
	canvasWidth: number,
	canvasHeight: number,
	paddedTextureSourceRef: RefObject<Texture | undefined>,
	paddedTextureRef: RefObject<Texture | undefined>,
): Promise<undefined> => {
	return new Promise((resolve) => {
		if (renderWorker) {
			const ApplyProcessImageConfigToCanvasData: BaseLayerRenderApplyProcessImageConfigToCanvasData =
				{
					type: BaseLayerRenderMessageType.ApplyProcessImageConfigToCanvas,
					payload: {
						imageContainerKey: imageContainerKey,
						processImageConfig: processImageConfig,
						canvasWidth: canvasWidth,
						canvasHeight: canvasHeight,
					},
				};
			const handleMessage = (event: MessageEvent<RenderResult>) => {
				const { type, payload } = event.data;
				if (
					type === BaseLayerRenderMessageType.ApplyProcessImageConfigToCanvas
				) {
					resolve(payload);
					renderWorker.removeEventListener("message", handleMessage);
				}
			};
			renderWorker.addEventListener("message", handleMessage);

			renderWorker.postMessage(ApplyProcessImageConfigToCanvasData);
		} else {
			renderApplyProcessImageConfigToCanvasAction(
				canvasAppRef,
				canvasContainerMapRef,
				blurSpriteMapRef,
				currentImageTextureRef,
				imageContainerKey,
				processImageConfig,
				canvasWidth,
				canvasHeight,
				paddedTextureSourceRef,
				paddedTextureRef,
			);
			resolve(undefined);
		}
	});
};
