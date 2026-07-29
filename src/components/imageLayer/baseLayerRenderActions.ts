import type { Application, ApplicationOptions } from "pixi.js";
import * as PIXI from "pixi.js";
import * as PIXIFilters from "pixi-filters";
import type { RefObject } from "react";
import type { SelectRectParams } from "@/pages/draw/components/selectLayer";
import type { ImageSharedBufferData } from "@/pages/draw/tools";
import type { FixedContentProcessImageConfig } from "@/pages/fixedContent/components/fixedContentCore";
import type { ElementRect } from "@/types/commands/screenshot";
import type { RefWrap } from "./workers/renderWorkerTypes";

export type RefType<T> = RefWrap<T> | RefObject<T>;

export const renderInitBaseImageTextureAction = async (
	baseImageTextureRef: RefType<PIXI.Texture | undefined>,
	imageUrl: string,
): Promise<{ width: number; height: number }> => {
	const texture = await PIXI.Assets.load<PIXI.Texture>({
		src: imageUrl,
		parser: "texture",
	});
	baseImageTextureRef.current = texture;
	return { width: texture.width, height: texture.height };
};

export const renderDisposeCanvasAction = (
	canvasAppRef: RefType<Application | undefined>,
) => {
	const canvasApp = canvasAppRef.current;
	if (!canvasApp) {
		return;
	}
	canvasApp.destroy(true, true);
	canvasAppRef.current = undefined;
};

export const renderInitCanvasAction = async (
	canvasAppRef: RefType<Application | undefined>,
	appOptions: Partial<ApplicationOptions>,
): Promise<OffscreenCanvas | HTMLCanvasElement | undefined> => {
	renderDisposeCanvasAction(canvasAppRef);

	const canvasApp = new PIXI.Application();
	try {
		await canvasApp.init({
			...appOptions,
		});
	} catch (error) {
		// WebGPU 初始化失败（WebView/Worker 环境不支持等），自动回退到 WebGL
		if (appOptions.preference === "webgpu") {
			console.warn(
				"[renderInitCanvasAction] WebGPU init failed, fallback to WebGL",
				error,
			);
			await canvasApp.init({
				...appOptions,
				preference: "webgl",
			});
		} else {
			throw error;
		}
	}
	canvasAppRef.current = canvasApp;
	canvasApp.stage.interactiveChildren = false;
	return canvasApp.canvas;
};

export const renderCreateNewCanvasContainerAction = (
	canvasAppRef: RefType<Application | undefined>,
	canvasContainerListRef: RefType<Map<string, PIXI.Container>>,
	containerKey: string,
) => {
	const canvasApp = canvasAppRef.current;
	if (!canvasApp) {
		return;
	}

	const container = new PIXI.Container();
	container.zIndex = canvasContainerListRef.current.size + 1;
	container.sortableChildren = true;
	container.x = 0;
	container.y = 0;
	canvasApp.stage.addChild(container);
	canvasContainerListRef.current.set(containerKey, container);

	return containerKey;
};

export const renderResizeCanvasAction = (
	canvasAppRef: RefType<Application | undefined>,
	width: number,
	height: number,
) => {
	const canvasApp = canvasAppRef.current;
	if (!canvasApp) {
		return;
	}

	canvasApp.renderer.resize(width, height);
};

export const renderClearCanvasAction = (
	canvasAppRef: RefType<Application | undefined>,
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	canvasContainerChildCountRef: RefType<number>,
	currentImageTextureRef: RefType<PIXI.Texture | undefined>,
	baseImageTextureRef: RefType<PIXI.Texture | undefined>,
) => {
	const canvasApp = canvasAppRef.current;
	if (!canvasApp) {
		return;
	}
	canvasApp.stage.removeChildren();
	canvasContainerMapRef.current.clear();
	canvasContainerChildCountRef.current = 0;
	currentImageTextureRef.current = undefined;
	baseImageTextureRef.current = undefined;

	canvasApp.render();
};

export const renderGetImageBitmapAction = async (
	canvasAppRef: RefType<Application | undefined>,
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	imageContainerKey: string,
	selectRect: ElementRect | undefined,
	renderContainerKey: string | undefined,
): Promise<ImageBitmap | undefined> => {
	const canvasApp = canvasAppRef.current;
	if (!canvasApp) {
		return;
	}

	let renderContainer = canvasApp.stage;
	if (renderContainerKey) {
		const container = canvasContainerMapRef.current.get(renderContainerKey);
		if (container) {
			renderContainer = container;
		}
	}

	const imageContainer = canvasContainerMapRef.current.get(imageContainerKey);
	let hasChangeAlpha = false;
	if (imageContainer?.children[0] && imageContainer.children[0].alpha === 0) {
		imageContainer.children[0].alpha = 1;
		hasChangeAlpha = true;
	}

	const canvas = canvasApp.renderer.extract.canvas({
		target: renderContainer,
		frame: selectRect
			? new PIXI.Rectangle(
					selectRect.min_x,
					selectRect.min_y,
					selectRect.max_x - selectRect.min_x,
					selectRect.max_y - selectRect.min_y,
				)
			: undefined,
	});

	if (imageContainer?.children[0] && hasChangeAlpha) {
		imageContainer.children[0].alpha = 0;
	}

	const result = await self.createImageBitmap(canvas as OffscreenCanvas);
	return result;
};

export const renderRenderToCanvasAction = (
	canvasAppRef: RefType<Application | undefined>,
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	imageContainerKey: string,
	selectRect: ElementRect,
	containerId: string | undefined,
): PIXI.ICanvas | undefined => {
	const canvasApp = canvasAppRef.current;
	if (!canvasApp) {
		return;
	}

	const imageContainer = canvasContainerMapRef.current.get(imageContainerKey);
	let hasChangeAlpha = false;
	if (imageContainer?.children[0] && imageContainer.children[0].alpha === 0) {
		imageContainer.children[0].alpha = 1;
		hasChangeAlpha = true;
	}

	const container = containerId
		? canvasContainerMapRef.current.get(containerId)
		: undefined;

	if (imageContainer?.children[0] && hasChangeAlpha) {
		imageContainer.children[0].alpha = 0;
	}

	return canvasApp.renderer.extract.canvas({
		target: container ?? canvasApp.stage,
		frame: new PIXI.Rectangle(
			selectRect.min_x,
			selectRect.min_y,
			selectRect.max_x - selectRect.min_x,
			selectRect.max_y - selectRect.min_y,
		),
	});
};

export const renderRenderToPngAction = async (
	canvasAppRef: RefType<Application | undefined>,
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	imageContainerKey: string,
	selectRect: ElementRect,
	containerId: string | undefined,
): Promise<ArrayBuffer | undefined> => {
	const canvasApp = canvasAppRef.current;
	if (!canvasApp) {
		return;
	}

	const container = containerId
		? canvasContainerMapRef.current.get(containerId)
		: undefined;

	const imageContainer = canvasContainerMapRef.current.get(imageContainerKey);
	let hasChangeAlpha = false;
	if (imageContainer?.children[0] && imageContainer.children[0].alpha === 0) {
		imageContainer.children[0].alpha = 1;
		hasChangeAlpha = true;
	}

	const canvas = canvasApp.renderer.extract.canvas({
		target: container ?? canvasApp.stage,
		frame: new PIXI.Rectangle(
			selectRect.min_x,
			selectRect.min_y,
			selectRect.max_x - selectRect.min_x,
			selectRect.max_y - selectRect.min_y,
		),
	});

	if (imageContainer?.children[0] && hasChangeAlpha) {
		imageContainer.children[0].alpha = 0;
	}

	const blob = await canvas.convertToBlob?.({
		type: "image/png",
		quality: 1,
	});

	if (!blob) {
		return;
	}

	return await blob.arrayBuffer();
};

export const renderCanvasRenderAction = (
	canvasAppRef: RefType<Application | undefined>,
) => {
	const canvasApp = canvasAppRef.current;
	if (!canvasApp) {
		return;
	}

	canvasApp.render();
};

export const renderAddImageToContainerAction = async (
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	currentImageTextureRef: RefType<PIXI.Texture | undefined>,
	sharedBufferImageTextureRef: RefType<PIXI.Texture | undefined>,
	imageSharedBufferRef: RefType<ImageSharedBufferData | undefined>,
	baseImageTextureRef: RefType<PIXI.Texture | undefined>,
	containerKey: string,
	imageSrc:
		| string
		| ImageBitmap
		| ImageSharedBufferData
		| { type: "base_image_texture" }
		| { type: "shared_buffer_image_texture" },
	hideImageSprite?: boolean,
): Promise<void> => {
	const container = canvasContainerMapRef.current.get(containerKey);
	if (!container) {
		return;
	}

	let texture: PIXI.Texture | undefined;
	if (typeof imageSrc === "object") {
		if ("type" in imageSrc) {
			if (imageSrc.type === "base_image_texture") {
				texture = baseImageTextureRef.current;
				baseImageTextureRef.current = undefined;
			} else if (imageSrc.type === "shared_buffer_image_texture") {
				texture = sharedBufferImageTextureRef.current;
			}
		} else if (imageSrc instanceof ImageBitmap) {
			texture = PIXI.Texture.from(imageSrc);
		} else {
			texture = new PIXI.Texture({
				source: new PIXI.BufferImageSource({
					resource: imageSrc.sharedBuffer,
					width: imageSrc.width,
					height: imageSrc.height,
					alphaMode: "no-premultiply-alpha",
					format: "rgba8unorm",
				}),
			});
			imageSharedBufferRef.current = imageSrc;
			// hideImageSprite 一般是来自于固定到屏幕的显示
			// 而 sharedBufferImageTextureRef 用于截图历史的切换，这里不多余记录
			if (!hideImageSprite) {
				sharedBufferImageTextureRef.current = texture;
			}
		}
	} else if (typeof imageSrc === "string") {
		texture = await PIXI.Assets.load<PIXI.Texture>({
			src: imageSrc,
			parser: "texture",
		});
	}

	container.removeChildren();

	const image = new PIXI.Sprite(texture);
	image.alpha = hideImageSprite ? 0 : 1;
	container.addChild(image);

	currentImageTextureRef.current = texture;
};

export const renderTransferImageSharedBufferAction = (
	imageSharedBufferRef: RefType<ImageSharedBufferData | undefined>,
) => {
	if (!imageSharedBufferRef.current) {
		return;
	}

	return imageSharedBufferRef.current;
};

export const renderClearContainerAction = (
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	containerKey: string,
) => {
	const container = canvasContainerMapRef.current.get(containerKey);
	if (!container) {
		return;
	}

	container.removeChildren();
};

export type BlurSprite = {
	spriteContainer: PIXI.Container;
	sprite: PIXI.Sprite;
	spriteBlurFliter: PIXI.Filter | undefined;
	spriteMask: PIXI.Graphics;
	customTexture: PIXI.RenderTexture | undefined;
};

/**
 * 将高亮容器渲染为纹理，用于模糊精灵使用。
 * 这样模糊区域内也能显示高亮效果。
 */
const renderGenerateHighlightTextureAction = (
	canvasAppRef: RefType<Application | undefined>,
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	currentImageTextureRef: RefType<PIXI.Texture | undefined>,
	highlightContainerKey: string,
): PIXI.Texture | undefined => {
	const canvasApp = canvasAppRef.current;
	const currentImageTexture = currentImageTextureRef.current;

	if (!canvasApp || !currentImageTexture) {
		return currentImageTexture;
	}

	const highlightContainer = canvasContainerMapRef.current.get(
		highlightContainerKey,
	);

	// 如果高亮容器不存在或没有子元素，使用原始纹理
	if (!highlightContainer || highlightContainer.children.length === 0) {
		return currentImageTexture;
	}

	const renderer = canvasApp.renderer;
	const { width, height } = renderer;

	const renderTexture = PIXI.RenderTexture.create({ width, height });

	renderer.render(highlightContainer, { renderTexture });

	return renderTexture;
};

export const renderCreateBlurSpriteAction = (
	canvasAppRef: RefType<Application | undefined>,
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	currentImageTextureRef: RefType<PIXI.Texture | undefined>,
	blurSpriteMapRef: RefType<Map<string, BlurSprite>>,
	blurContainerKey: string,
	blurElementId: string,
	highlightContainerKey: string,
) => {
	const container = canvasContainerMapRef.current.get(blurContainerKey);
	if (!container) {
		return;
	}

	const currentImageTexture = currentImageTextureRef.current;
	if (!currentImageTexture) {
		return;
	}

	const spriteTexture = renderGenerateHighlightTextureAction(
		canvasAppRef,
		canvasContainerMapRef,
		currentImageTextureRef,
		highlightContainerKey,
	);

	let customTexture: PIXI.RenderTexture | undefined;
	if (spriteTexture && spriteTexture !== currentImageTexture) {
		customTexture = spriteTexture as PIXI.RenderTexture;
	}

	const blurSprite: BlurSprite = {
		spriteContainer: new PIXI.Container(),
		sprite: new PIXI.Sprite(spriteTexture ?? currentImageTexture),
		spriteBlurFliter: undefined,
		spriteMask: new PIXI.Graphics(),
		customTexture,
	};

	blurSprite.sprite.filters = undefined;
	blurSprite.spriteContainer.setMask({
		mask: blurSprite.spriteMask,
	});
	blurSprite.spriteMask.setFillStyle({
		color: "white",
		alpha: 1,
	});
	blurSprite.spriteContainer.addChild(blurSprite.sprite);
	blurSprite.spriteContainer.addChild(blurSprite.spriteMask);
	container.addChild(blurSprite.spriteContainer);

	blurSpriteMapRef.current.set(blurElementId, blurSprite);
};

export type BlurSpriteProps = {
	blur: number;
	filterType: string;
	x: number;
	y: number;
	width: number;
	height: number;
	angle: number;
	opacity: number;
	zoom: number;
	strokeWidth: number | undefined;
	eraserAlpha: undefined | number;
	points?: readonly [x: number, y: number][];
};

/**
 * 计算旋转和缩放后矩形的边界框，用于设置 filterArea
 * 注意：此函数计算的是与 spriteMask 变换相匹配的区域
 * spriteMask 的变换顺序：rotate -> translate(center) -> scale(zoom) -> rect
 * @param x 矩形左上角 x 坐标（未缩放）
 * @param y 矩形左上角 y 坐标（未缩放）
 * @param width 矩形宽度（未缩放）
 * @param height 矩形高度（未缩放）
 * @param angle 旋转角度（弧度）
 * @param zoom 缩放比例
 */
/**
 * 获取或创建 filter 实例
 * 如果相同参数的 filter 已存在，则返回已存在的 filter；否则创建新的 filter
 * @param blurSpriteFilterMapRef filter 实例缓存
 * @param filterType filter 类型
 * @param blur 模糊强度
 * @returns filter 实例
 */
const getOrCreateBlurFilter = (
	blurSpriteFilterMapRef: RefType<Map<string, PIXI.Filter>>,
	filterType: string,
	blur: number,
): PIXI.Filter => {
	const filterKey = `${filterType}-${blur}`;
	const existingFilter = blurSpriteFilterMapRef.current.get(filterKey);

	if (existingFilter) {
		return existingFilter;
	}

	let newFilter: PIXI.Filter;

	if (filterType === "pixelate") {
		const size = Math.max(1, (blur / 100) * 12);
		newFilter = new PIXIFilters.PixelateFilter(size);
		newFilter.resolution = 0.3;
	} else if (filterType === "ascii") {
		const size = Math.max(2, (blur / 100) * 20);
		newFilter = new PIXIFilters.AsciiFilter({ size });
		newFilter.resolution = 0.3;
	} else if (filterType === "crossHatch") {
		newFilter = new PIXIFilters.CrossHatchFilter();
		newFilter.resolution = 0.5;
	} else if (filterType === "crt") {
		const lineWidth = Math.max(1, (blur / 100) * 5);
		newFilter = new PIXIFilters.CRTFilter({ lineWidth });
		newFilter.resolution = 1;
	} else if (filterType === "dot") {
		const scale = Math.max(0.1, blur / 100);
		newFilter = new PIXIFilters.DotFilter({ scale });
		newFilter.resolution = 0.3;
	} else if (filterType === "emboss") {
		const strength = Math.max(1, (blur / 100) * 20);
		newFilter = new PIXIFilters.EmbossFilter(strength);
		newFilter.resolution = 0.8;
	} else if (filterType === "grayscale") {
		newFilter = new PIXIFilters.GrayscaleFilter();
		newFilter.resolution = 1;
	} else if (filterType === "kawaseBlur") {
		const strength = Math.max(1, (blur / 100) * 32);
		newFilter = new PIXIFilters.KawaseBlurFilter({ strength });
		newFilter.resolution = 0.3;
	} else if (filterType === "motionBlur") {
		const kernelSize = Math.max(1, (blur / 100) * 25);
		newFilter = new PIXIFilters.MotionBlurFilter({
			kernelSize,
			velocity: { x: 42, y: 42 },
		});
		newFilter.resolution = 0.3;
	} else if (filterType === "rgbSplit") {
		const offset = (blur / 100) * 12;
		newFilter = new PIXIFilters.RGBSplitFilter({
			red: { x: offset, y: offset },
			green: { x: 0, y: 0 },
			blue: { x: -offset, y: -offset },
		});
		newFilter.resolution = 1;
	} else if (filterType === "noise") {
		const noise = blur / 100;
		newFilter = new PIXI.NoiseFilter({ noise });
		newFilter.resolution = 1;
	} else if (filterType === "negative") {
		const negativeFilter = new PIXI.ColorMatrixFilter();
		negativeFilter.negative(false);
		negativeFilter.resolution = 1;
		newFilter = negativeFilter;
	} else {
		// 默认使用 blur filter
		const strength = Math.max(1, (blur / 100) * 42);
		newFilter = new PIXI.BlurFilter({
			strength,
			quality: 2,
			kernelSize: 5,
		});
		newFilter.resolution = 0.3;
	}

	blurSpriteFilterMapRef.current.set(filterKey, newFilter);
	return newFilter;
};

/**
 * 计算旋转和缩放后矩形的边界框，用于设置 filterArea
 * 注意：此函数计算的是与 spriteMask 变换相匹配的区域
 * spriteMask 的变换顺序：rotate -> translate(center) -> scale(zoom) -> rect
 * @param x 矩形左上角 x 坐标（未缩放）
 * @param y 矩形左上角 y 坐标（未缩放）
 * @param width 矩形宽度（未缩放）
 * @param height 矩形高度（未缩放）
 * @param angle 旋转角度（弧度）
 * @param zoom 缩放比例
 */
const calculateRotatedFilterArea = (
	x: number,
	y: number,
	width: number,
	height: number,
	angle: number,
	zoom: number,
): PIXI.Rectangle => {
	// 中心点坐标（变换的中心）
	const centerX = (x + width * 0.5) * zoom;
	const centerY = (y + height * 0.5) * zoom;

	// 缩放后的尺寸
	const scaledWidth = width * zoom;
	const scaledHeight = height * zoom;

	if (angle === 0) {
		// 无旋转时，直接计算缩放后的矩形位置
		// 由于缩放是围绕中心点的，所以左上角位置需要调整
		return new PIXI.Rectangle(
			centerX - scaledWidth * 0.5,
			centerY - scaledHeight * 0.5,
			scaledWidth,
			scaledHeight,
		);
	}

	// 旋转后的矩形半宽和半高
	const halfWidth = scaledWidth * 0.5;
	const halfHeight = scaledHeight * 0.5;

	const cos = Math.cos(angle);
	const sin = Math.sin(angle);

	// 计算旋转后的四个顶点（展开循环以提高性能）
	// 左上角
	const x1 = -halfWidth * cos - -halfHeight * sin + centerX;
	const y1 = -halfWidth * sin + -halfHeight * cos + centerY;

	// 右上角
	const x2 = halfWidth * cos - -halfHeight * sin + centerX;
	const y2 = halfWidth * sin + -halfHeight * cos + centerY;

	// 左下角
	const x3 = -halfWidth * cos - halfHeight * sin + centerX;
	const y3 = -halfWidth * sin + halfHeight * cos + centerY;

	// 右下角
	const x4 = halfWidth * cos - halfHeight * sin + centerX;
	const y4 = halfWidth * sin + halfHeight * cos + centerY;

	const minX = Math.min(x1, x2, x3, x4);
	const minY = Math.min(y1, y2, y3, y4);
	const maxX = Math.max(x1, x2, x3, x4);
	const maxY = Math.max(y1, y2, y3, y4);

	return new PIXI.Rectangle(minX, minY, maxX - minX, maxY - minY);
};

export const renderUpdateBlurSpriteAction = (
	blurSpriteMapRef: RefType<Map<string, BlurSprite>>,
	/// 用于共享相同值的 filter 实例， key 为 ${filterType}-${blur}
	blurSpriteFilterMapRef: RefType<Map<string, PIXI.Filter>>,
	blurElementId: string,
	blurProps: BlurSpriteProps,
	updateFilter: boolean,
	windowDevicePixelRatio: number,
) => {
	const blurSprite = blurSpriteMapRef.current.get(blurElementId);
	if (!blurSprite) {
		return;
	}

	if (blurProps.points) {
		// 计算points的边界框中心，用于旋转中心
		let minX = 0;
		let minY = 0;

		for (const point of blurProps.points) {
			minX = Math.min(minX, point[0]);
			minY = Math.min(minY, point[1]);
		}

		minX *= windowDevicePixelRatio;
		minY *= windowDevicePixelRatio;

		const rectMinX = 0 + minX + blurProps.x;
		const rectMinY = 0 + minY + blurProps.y;

		blurSprite.spriteMask
			.clear()
			.rotateTransform(blurProps.angle)
			.translateTransform(
				rectMinX + blurProps.width * 0.5,
				rectMinY + blurProps.height * 0.5,
			)
			.scaleTransform(blurProps.zoom, blurProps.zoom);
		const baseX = -(blurProps.width * 0.5 + minX);
		const baseY = -(blurProps.height * 0.5 + minY);
		blurSprite.spriteMask.moveTo(
			blurProps.points[0][0] * windowDevicePixelRatio + baseX,
			blurProps.points[0][1] * windowDevicePixelRatio + baseY,
		);
		for (const point of blurProps.points) {
			blurSprite.spriteMask.lineTo(
				point[0] * windowDevicePixelRatio + baseX,
				point[1] * windowDevicePixelRatio + baseY,
			);
		}
		const strokeWidth =
			(blurProps.strokeWidth ?? 0) *
			9 *
			windowDevicePixelRatio *
			blurProps.zoom;
		blurSprite.spriteMask.stroke({
			width: strokeWidth,
			join: "round",
			color: "red",
		});

		// 计算 points 情况下的 filterArea
		// 扩展区域以包含笔画宽度
		const expandedWidth = blurProps.width + strokeWidth;
		const expandedHeight = blurProps.height + strokeWidth;
		const expandedX = rectMinX - strokeWidth * 0.5;
		const expandedY = rectMinY - strokeWidth * 0.5;

		blurSprite.sprite.filterArea = calculateRotatedFilterArea(
			expandedX,
			expandedY,
			expandedWidth,
			expandedHeight,
			blurProps.angle,
			blurProps.zoom,
		);
	} else {
		blurSprite.spriteMask
			.clear()
			.rotateTransform(blurProps.angle)
			.translateTransform(
				blurProps.x + blurProps.width * 0.5,
				blurProps.y + blurProps.height * 0.5,
			)
			.scaleTransform(blurProps.zoom, blurProps.zoom)
			.rect(
				-blurProps.width * 0.5,
				-blurProps.height * 0.5,
				blurProps.width,
				blurProps.height,
			)
			.fill();

		// 计算矩形情况下的 filterArea
		blurSprite.sprite.filterArea = calculateRotatedFilterArea(
			blurProps.x,
			blurProps.y,
			blurProps.width,
			blurProps.height,
			blurProps.angle,
			blurProps.zoom,
		);
	}

	blurSprite.spriteContainer.alpha =
		blurProps.eraserAlpha ?? blurProps.opacity / 100;

	// 当需要更新 filter 或者 filter 不存在时，使用共享的 filter 实例
	if (updateFilter || !blurSprite.spriteBlurFliter) {
		const newFilter = getOrCreateBlurFilter(
			blurSpriteFilterMapRef,
			blurProps.filterType,
			blurProps.blur,
		);

		// 如果 filter 实例发生了变化，更新 sprite 的 filters
		if (blurSprite.spriteBlurFliter !== newFilter) {
			blurSprite.spriteBlurFliter = newFilter;
			blurSprite.sprite.filters = [newFilter];
		}
	}
};

export const renderDeleteBlurSpriteAction = (
	blurSpriteMapRef: RefType<Map<string, BlurSprite>>,
	blurElementId: string,
) => {
	const blurSprite = blurSpriteMapRef.current.get(blurElementId);
	if (!blurSprite) {
		return;
	}

	if (blurSprite.customTexture) {
		blurSprite.customTexture.destroy(true);
	}

	blurSprite.sprite.destroy();
	blurSprite.spriteContainer.destroy();
	blurSprite.spriteMask.destroy();
	blurSpriteMapRef.current.delete(blurElementId);
};

export type HighlightProps = {
	selectRectParams: SelectRectParams;
};

export type HighlightElementProps = {
	x: number;
	y: number;
	width: number;
	height: number;
	angle: number;
	opacity: number;
	zoom: number;
	strokeColor: string;
	strokeWidth: number;
	backgroundColor: string;
	maskColor: string;
	maskOpacity: number;
	borderType: string;
	shapeType: string;
	eraserAlpha: number | undefined;
};

export type HighlightElement = {
	props: HighlightElementProps;
	strokeGraphics: PIXI.Graphics;
	backgroundGraphics: PIXI.Graphics;
	backgroundMaskGraphics: PIXI.Graphics;
};

const drawShapeHighlightElementGraphicsAction = (
	graphics: PIXI.Graphics,
	highlightProps: HighlightElementProps,
) => {
	const halfWidth = highlightProps.width * 0.5;
	const halfHeight = highlightProps.height * 0.5;
	graphics
		.rotateTransform(highlightProps.angle)
		.translateTransform(
			highlightProps.x + halfWidth,
			highlightProps.y + halfHeight,
		)
		.scaleTransform(highlightProps.zoom, highlightProps.zoom);
	if (highlightProps.shapeType === "rect") {
		graphics.rect(
			-halfWidth,
			-halfHeight,
			highlightProps.width,
			highlightProps.height,
		);
	} else {
		const radiusX = highlightProps.width * 0.5;
		const radiusY = highlightProps.height * 0.5;
		graphics.ellipse(0, 0, radiusX, radiusY);
	}
};

/**
 * 更新指定 highlight 元素的 props
 */
export const renderUpdateHighlightElementPropsAction = (
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	currentImageTextureRef: RefType<PIXI.Texture | undefined>,
	highlightElementMapRef: RefType<Map<string, HighlightElement>>,
	highlightContainerKey: string,
	highlightElementId: string,
	highlightProps: HighlightElementProps | undefined,
	windowDevicePixelRatio: number,
) => {
	let highlightElement = highlightElementMapRef.current.get(highlightElementId);
	if (!highlightProps) {
		highlightElementMapRef.current.delete(highlightElementId);

		if (highlightElement) {
			highlightElement.strokeGraphics.destroy();
			highlightElement.backgroundGraphics.destroy();
			highlightElement.backgroundMaskGraphics.destroy();
		}

		return;
	}

	const container = canvasContainerMapRef.current.get(highlightContainerKey);
	if (!container) {
		return;
	}

	const currentImageTexture = currentImageTextureRef.current;
	if (!currentImageTexture) {
		return;
	}

	// 判断是否创建 highlight 的 graphics
	let highlightBaseImageSprite = container.children[0]?.children?.[0] as
		| PIXI.Sprite
		| undefined; // 渲染 highlight 的底图，用来处理高亮效果，避免底图透明时高亮效果不生效
	let highlightContainer = container.children[1] as PIXI.Container | undefined; // 渲染 highlight 的背景
	let highlightBackgroundGraphics = container.children[2]
		?.children?.[0] as PIXI.Graphics; // 渲染 highlight 的背景
	let highlightStrokeContainer = container.children[2]
		?.children?.[1] as PIXI.Container; // 渲染 highlight 的描边
	let highlightBackgroundMaskContainer = container
		.children[3] as PIXI.Container; // 渲染 highlight 的描边遮罩
	if (!highlightContainer) {
		highlightContainer = new PIXI.Container();

		const highlightBaseImageContainer = new PIXI.Container();
		highlightBaseImageSprite = new PIXI.Sprite(currentImageTexture);
		highlightBaseImageContainer.addChild(highlightBaseImageSprite);

		const highlightMaskContentContainer = new PIXI.Container();
		highlightBackgroundGraphics = new PIXI.Graphics();
		highlightStrokeContainer = new PIXI.Container();
		highlightMaskContentContainer.addChild(highlightBackgroundGraphics);
		highlightMaskContentContainer.addChild(highlightStrokeContainer);

		highlightBackgroundMaskContainer = new PIXI.Container();

		highlightBaseImageContainer.setMask({
			mask: highlightBackgroundMaskContainer,
		});

		highlightMaskContentContainer.setMask({
			mask: highlightBackgroundMaskContainer,
			inverse: true,
		});

		container.addChild(highlightBaseImageContainer);
		container.addChild(highlightContainer);
		container.addChild(highlightMaskContentContainer);
		container.addChild(highlightBackgroundMaskContainer);
	}

	if (!highlightElement) {
		highlightElement = {
			props: highlightProps,
			strokeGraphics: new PIXI.Graphics(),
			backgroundGraphics: new PIXI.Graphics(),
			backgroundMaskGraphics: new PIXI.Graphics(),
		};

		highlightElement.backgroundGraphics.blendMode = "multiply";

		highlightContainer.addChild(highlightElement.backgroundGraphics);
		highlightStrokeContainer.addChild(highlightElement.strokeGraphics);
		highlightBackgroundMaskContainer.addChild(
			highlightElement.backgroundMaskGraphics,
		);
	}

	highlightElement.props = highlightProps;
	highlightElementMapRef.current.set(highlightElementId, highlightElement);

	const alpha = highlightProps.eraserAlpha ?? highlightProps.opacity / 100;

	highlightElement.strokeGraphics.clear();
	highlightElement.backgroundGraphics.clear();
	highlightElement.backgroundMaskGraphics.clear();

	if (highlightProps.borderType === "solid") {
		drawShapeHighlightElementGraphicsAction(
			highlightElement.strokeGraphics,
			highlightProps,
		);
		highlightElement.strokeGraphics.stroke({
			color: highlightProps.strokeColor,
			width: highlightProps.strokeWidth * 6 * windowDevicePixelRatio,
		});
		highlightElement.strokeGraphics.alpha = alpha;
	}
	drawShapeHighlightElementGraphicsAction(
		highlightElement.backgroundGraphics,
		highlightProps,
	);
	highlightElement.backgroundGraphics.fill({
		color: highlightProps.backgroundColor,
	});
	highlightElement.backgroundGraphics.alpha = alpha;

	drawShapeHighlightElementGraphicsAction(
		highlightElement.backgroundMaskGraphics,
		highlightProps,
	);
	highlightElement.backgroundMaskGraphics.fill("black");
};

/**
 * 重新渲染 highlight
 */
export const renderUpdateHighlightAction = (
	canvasAppRef: RefType<Application | undefined>,
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	highlightElementMapRef: RefType<Map<string, HighlightElement>>,
	blurSpriteMapRef: RefType<Map<string, BlurSprite>>,
	currentImageTextureRef: RefType<PIXI.Texture | undefined>,
	highlightContainerKey: string,
	highlightProps: HighlightProps,
) => {
	const container = canvasContainerMapRef.current.get(highlightContainerKey);
	if (!container) {
		return;
	}

	const highlightBackgroundGraphics = container.children[2]?.children?.[0] as
		| PIXI.Graphics
		| undefined; // 渲染 highlight 的背景遮罩
	if (!highlightBackgroundGraphics) {
		return;
	}

	highlightBackgroundGraphics.clear();
	if (highlightElementMapRef.current.size === 0) {
		// 高亮被清除时，更新模糊精灵纹理回原始截图
		const currentImageTexture = currentImageTextureRef.current;
		if (currentImageTexture) {
			for (const blurSprite of blurSpriteMapRef.current.values()) {
				if (blurSprite.customTexture) {
					blurSprite.customTexture.destroy(true);
					blurSprite.customTexture = undefined;
				}
				blurSprite.sprite.texture = currentImageTexture;
			}
		}
		return;
	}

	const firstHighlightElement = highlightElementMapRef.current
		.values()
		.next().value;

	if (firstHighlightElement) {
		highlightBackgroundGraphics
			.roundRect(
				highlightProps.selectRectParams.rect.min_x,
				highlightProps.selectRectParams.rect.min_y,
				highlightProps.selectRectParams.rect.max_x -
					highlightProps.selectRectParams.rect.min_x,
				highlightProps.selectRectParams.rect.max_y -
					highlightProps.selectRectParams.rect.min_y,
				highlightProps.selectRectParams.radius,
			)
			.fill({
				color: firstHighlightElement.props.maskColor,
			});
		highlightBackgroundGraphics.alpha =
			firstHighlightElement.props.maskOpacity / 100;
	}

	// 高亮更新后，更新所有模糊精灵的纹理以包含最新高亮效果
	const canvasApp = canvasAppRef.current;
	if (canvasApp) {
		for (const blurSprite of blurSpriteMapRef.current.values()) {
			if (blurSprite.customTexture) {
				blurSprite.customTexture.destroy(true);
				blurSprite.customTexture = undefined;
			}

			const newTexture = renderGenerateHighlightTextureAction(
				canvasAppRef,
				canvasContainerMapRef,
				currentImageTextureRef,
				highlightContainerKey,
			);

			if (newTexture && newTexture !== currentImageTextureRef.current) {
				blurSprite.customTexture = newTexture as PIXI.RenderTexture;
			}

			const fallbackTexture = currentImageTextureRef.current;
			if (fallbackTexture) {
				blurSprite.sprite.texture = newTexture ?? fallbackTexture;
			}
		}
	}
};

export type WatermarkProps = {
	selectRectParams: SelectRectParams;
	fontSize: number;
	color: string;
	opacity: number;
	text: string;
	visible: boolean;
};

const watermarkTextRotateAngle = Math.PI * (45 / 180);
const watermarkTextPadding = 32;

const getWatermarkSpriteAlpha = (opacity: number) => {
	return (opacity / 100) * 0.24;
};

export const renderUpdateWatermarkSpriteAction = (
	canvasAppRef: RefType<Application | undefined>,
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	watermarkContainerKey: string,
	lastWatermarkPropsRef: RefType<WatermarkProps>,
	watermarkProps: WatermarkProps,
	textResolution: number,
) => {
	const { selectRectParams: lastSelectRectParams } =
		lastWatermarkPropsRef.current;
	const { selectRectParams } = watermarkProps;

	const container = canvasContainerMapRef.current.get(watermarkContainerKey);
	if (!container) {
		return;
	}

	const canvasApp = canvasAppRef.current;
	if (!canvasApp) {
		return;
	}

	container.visible = watermarkProps.visible;

	// 判断是否创建 watermark 的 sprite
	let watermarkSprite = container.children[0] as PIXI.TilingSprite | undefined;
	if (!watermarkSprite) {
		watermarkSprite = new PIXI.TilingSprite();
		container.addChild(watermarkSprite);
		// 重置下 lastWatermarkPropsRef.current 的 text，避免未渲染
		lastWatermarkPropsRef.current.text = "";
		lastWatermarkPropsRef.current.opacity = -1;
	}

	// 判断是否创建 watermark 的 mask
	let watermarkSpriteMask = container.children[1] as PIXI.Graphics | undefined;
	if (!watermarkSpriteMask) {
		watermarkSpriteMask = new PIXI.Graphics();
		container.addChild(watermarkSpriteMask);
		watermarkSprite.setMask({
			mask: watermarkSpriteMask,
		});
	}

	const { rect: selectRect } = selectRectParams;

	if (
		lastWatermarkPropsRef.current.text !== watermarkProps.text ||
		lastWatermarkPropsRef.current.fontSize !== watermarkProps.fontSize ||
		lastWatermarkPropsRef.current.color !== watermarkProps.color
	) {
		const textContainer = new PIXI.Container();
		const textSource = new PIXI.Text({
			text: watermarkProps.text,
			style: {
				fontSize: watermarkProps.fontSize,
				stroke: {
					color: watermarkProps.color,
				},
				fill: watermarkProps.color,
			},
			resolution: textResolution,
		});
		const textWidth = textSource.width;
		const textHeight = textSource.height;
		const rotatedWidth = Math.ceil(
			Math.abs(textWidth * Math.cos(watermarkTextRotateAngle)) +
				Math.abs(textHeight * Math.sin(watermarkTextRotateAngle)),
		);
		const rotatedHeight = Math.ceil(
			Math.abs(textWidth * Math.sin(watermarkTextRotateAngle)) +
				Math.abs(textHeight * Math.cos(watermarkTextRotateAngle)),
		);

		textContainer.addChild(
			new PIXI.Graphics()
				.rect(
					0,
					0,
					rotatedWidth + watermarkTextPadding,
					rotatedHeight + watermarkTextPadding,
				)
				.fill("transparent"),
		);
		textContainer.addChild(textSource);
		textContainer.width = rotatedWidth + watermarkTextPadding;
		textContainer.height = rotatedHeight + watermarkTextPadding;
		textSource.localTransform.rotate(watermarkTextRotateAngle);

		const textTexture = canvasApp.renderer.extract.texture(textContainer);
		watermarkSprite.texture = textTexture;
	}

	if (lastWatermarkPropsRef.current.opacity !== watermarkProps.opacity) {
		watermarkSprite.alpha = getWatermarkSpriteAlpha(watermarkProps.opacity); // 水印保持一定的透明度
	}

	// 比较耗时，做个节流
	if (
		lastSelectRectParams.radius !== selectRectParams.radius ||
		lastSelectRectParams.rect.min_x !== selectRectParams.rect.min_x ||
		lastSelectRectParams.rect.min_y !== selectRectParams.rect.min_y ||
		lastSelectRectParams.rect.max_x !== selectRectParams.rect.max_x ||
		lastSelectRectParams.rect.max_y !== selectRectParams.rect.max_y
	) {
		watermarkSprite.width = selectRect.max_x - selectRect.min_x;
		watermarkSprite.height = selectRect.max_y - selectRect.min_y;
		watermarkSprite.x = selectRect.min_x;
		watermarkSprite.y = selectRect.min_y;

		watermarkSpriteMask
			.clear()
			.roundRect(
				watermarkSprite.x,
				watermarkSprite.y,
				watermarkSprite.width,
				watermarkSprite.height,
				selectRectParams.radius,
			)
			.fill();
	}

	lastWatermarkPropsRef.current = watermarkProps;
	canvasApp.render();
};

export const renderClearContextAction = (
	blurSpriteMapRef: RefType<Map<string, BlurSprite>>,
	blurSpriteFilterMapRef: RefType<Map<string, PIXI.Filter>>,
	highlightElementMapRef: RefType<Map<string, HighlightElement>>,
	lastWatermarkPropsRef: RefType<WatermarkProps>,
) => {
	for (const blurSprite of blurSpriteMapRef.current.values()) {
		if (blurSprite.customTexture) {
			blurSprite.customTexture.destroy(true);
			blurSprite.customTexture = undefined;
		}
	}
	blurSpriteMapRef.current.clear();
	blurSpriteFilterMapRef.current.clear();
	highlightElementMapRef.current.clear();
	lastWatermarkPropsRef.current = {
		fontSize: 0,
		color: "#000000",
		opacity: 0,
		visible: false,
		text: "",
		selectRectParams: {
			rect: { min_x: 0, min_y: 0, max_x: 0, max_y: 0 },
			radius: 0,
			shadowWidth: 0,
			shadowColor: "#000000",
		},
	};
};

export const renderApplyProcessImageConfigToCanvasAction = (
	canvasAppRef: RefType<Application | undefined>,
	canvasContainerMapRef: RefType<Map<string, PIXI.Container>>,
	blurSpriteMapRef: RefType<Map<string, BlurSprite>>,
	currentImageTextureRef: RefType<PIXI.Texture | undefined>,
	imageContainerKey: string,
	processImageConfig: FixedContentProcessImageConfig,
	canvasWidth: number,
	canvasHeight: number,
) => {
	const canvasApp = canvasAppRef.current;
	if (!canvasApp) {
		return;
	}

	const container = canvasContainerMapRef.current.get(imageContainerKey);
	if (!container) {
		return;
	}

	renderResizeCanvasAction(canvasAppRef, canvasWidth, canvasHeight);

	const angle = processImageConfig.angle;

	// 重置基础变换
	container.x = 0;
	container.y = 0;
	container.pivot.x = 0;
	container.pivot.y = 0;
	container.scale.x = 1;
	container.scale.y = 1;
	container.rotation = 0;

	// 翻转缩放
	const sx = processImageConfig.horizontalFlip ? -1 : 1;
	const sy = processImageConfig.verticalFlip ? -1 : 1;

	// 原始内容尺寸（优先读取子 sprite 尺寸）
	const firstChild = container.children[0] as PIXI.Sprite | undefined;
	const baseWidth = firstChild?.width ?? canvasWidth;
	const baseHeight = firstChild?.height ?? canvasHeight;

	// 计算矩形四点在（scale -> rotate）后的坐标
	const transformPoint = (x: number, y: number) => {
		const x1 = sx * x;
		const y1 = sy * y;
		let xr = x1;
		let yr = y1;
		switch (angle) {
			case 0:
				xr = x1;
				yr = y1;
				break;
			case 1: // 逆时针 90°
				xr = -y1;
				yr = x1;
				break;
			case 2: // 180°
				xr = -x1;
				yr = -y1;
				break;
			case 3: // 逆时针 270°
				xr = y1;
				yr = -x1;
				break;
		}
		return { x: xr, y: yr };
	};

	const p00 = transformPoint(0, 0);
	const p10 = transformPoint(baseWidth, 0);
	const p01 = transformPoint(0, baseHeight);
	const p11 = transformPoint(baseWidth, baseHeight);

	const minX = Math.min(p00.x, p10.x, p01.x, p11.x);
	const minY = Math.min(p00.y, p10.y, p01.y, p11.y);

	// 应用到容器：先缩放（翻转），再旋转，最后位移到 (0,0)
	container.scale.x = sx;
	container.scale.y = sy;
	container.rotation = angle * (Math.PI / 2);
	container.x = -minX;
	container.y = -minY;

	// renderer.extract 渲染 image container 不会保留变换
	// 为了避免其它元素影响，先隐藏再显示
	for (const child of canvasApp.stage.children) {
		child.visible = false;
	}
	container.visible = true;

	// 将 ImageContainer 渲染出来，作为 Filter 元素的纹理
	const imageTexture = canvasApp.renderer.extract.texture({
		target: canvasApp.stage,
		frame: new PIXI.Rectangle(0, 0, canvasWidth, canvasHeight),
	});
	currentImageTextureRef.current = imageTexture;
	for (const blurSprite of blurSpriteMapRef.current.values()) {
		blurSprite.sprite.texture = imageTexture;
	}

	for (const child of canvasApp.stage.children) {
		child.visible = true;
	}

	canvasApp.render();
};
