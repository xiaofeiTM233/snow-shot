import {
	useCallback,
	useContext,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { useIntl } from "react-intl";
import { DrawStatePublisher } from "@/components/drawCore/extra";
import { INIT_CONTAINER_KEY } from "@/components/imageLayer/actions";
import {
	PLUGIN_ID_AI_CHAT,
	PLUGIN_ID_TRANSLATE,
} from "@/constants/pluginService";
import { AntdContext } from "@/contexts/antdContext";
import { AppSettingsPublisher } from "@/contexts/appSettingsActionContext";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import {
	type AllOcrResult,
	type AppOcrResult,
	covertOcrResultToText,
	OcrResult,
	type OcrResultActionType,
	type OcrResultType,
} from "@/pages/fixedContent/components/ocrResult";
import { AppSettingsGroup, OcrDetectAfterAction } from "@/types/appSettings";
import type { OcrDetectResult } from "@/types/commands/ocr";
import type { ElementRect } from "@/types/commands/screenshot";
import { DrawState } from "@/types/draw";
import { writeTextToClipboard } from "@/utils/clipboard";
import { executeTranslateOcrText } from "@/functions/tools";
import { ScreenshotType } from "@/utils/types";
import { zIndexs } from "@/utils/zIndex";
import { getCanvas } from "../../actions";
import {
	type CaptureBoundingBoxInfo,
	ScreenshotTypePublisher,
} from "../../extra";
import { DrawContext } from "../../types";
import OcrTool, { isOcrTool } from "../drawToolbar/components/tools/ocrTool";

export type OcrBlocksSelectedText = {
	type: "text" | "visionModelHtml";
	text: string;
};

export type OcrBlocksActionType = {
	init: (
		selectRect: ElementRect,
		captureBoundingBoxInfo: CaptureBoundingBoxInfo,
		canvas: HTMLCanvasElement,
		allOcrResult: AllOcrResult | undefined,
	) => Promise<void>;
	setEnable: (enable: boolean | ((enable: boolean) => boolean)) => void;
	getOcrResultAction: () => OcrResultActionType | undefined;
	getSelectedText: () => OcrBlocksSelectedText | undefined;
};

export const OcrBlocks: React.FC<{
	actionRef: React.RefObject<OcrBlocksActionType | undefined>;
	finishCapture: () => void;
}> = ({ actionRef, finishCapture }) => {
	const { selectLayerActionRef, imageLayerActionRef, drawLayerActionRef } =
		useContext(DrawContext);
	const ocrResultActionRef = useRef<OcrResultActionType>(undefined);

	const [getScreenshotType] = useStateSubscriber(
		ScreenshotTypePublisher,
		undefined,
	);
	const [getAppSettings] = useStateSubscriber(AppSettingsPublisher, undefined);
	const [getDrawState] = useStateSubscriber(
		DrawStatePublisher,
		useCallback((drawState: DrawState) => {
			ocrResultActionRef.current?.setEnable(isOcrTool(drawState));
			ocrResultActionRef.current?.clear();
		}, []),
	);

	useImperativeHandle(
		actionRef,
		() => ({
			init: async (
				selectRect: ElementRect,
				captureBoundingBoxInfo: CaptureBoundingBoxInfo,
				canvas: HTMLCanvasElement,
				allOcrResult: AllOcrResult | undefined,
			) => {
				await ocrResultActionRef.current?.init({
					selectRect,
					captureBoundingBoxInfo,
					canvas,
					allOcrResult,
				});
			},
			setEnable: (enable: boolean | ((enable: boolean) => boolean)) => {
				ocrResultActionRef.current?.setEnable(enable);
			},
			getOcrResultAction: () => {
				return ocrResultActionRef.current;
			},
			getSelectedText: () => {
				return ocrResultActionRef.current?.getSelectedText();
			},
		}),
		[],
	);

	const onOcrDetect = useCallback(
		(ocrResult: OcrDetectResult) => {
			// 判断是否是 OCR 工具
			if (!isOcrTool(getDrawState())) {
				return;
			}

			// 只在 OCR 检测时启用 OCR 后操作,截图翻译时不启用
			if (getDrawState() === DrawState.OcrDetect) {
				const ocrAfterAction =
					getAppSettings()[AppSettingsGroup.FunctionScreenshot].ocrAfterAction;

				if (
					ocrAfterAction === OcrDetectAfterAction.CopyText ||
					(ocrAfterAction === OcrDetectAfterAction.OcrDetectCopyText &&
						getScreenshotType().type === ScreenshotType.OcrDetect)
				) {
					writeTextToClipboard(covertOcrResultToText(ocrResult));
				} else if (
					ocrAfterAction === OcrDetectAfterAction.CopyTextAndCloseWindow ||
					(ocrAfterAction ===
						OcrDetectAfterAction.OcrDetectCopyTextAndCloseWindow &&
						getScreenshotType().type === ScreenshotType.OcrDetect)
				) {
					writeTextToClipboard(covertOcrResultToText(ocrResult));
					finishCapture?.();
				}
			} else if (getDrawState() === DrawState.OcrTranslate) {
				ocrResultActionRef.current?.startTranslate();
			}
		},
		[finishCapture, getAppSettings, getDrawState, getScreenshotType],
	);

	const onTranslate = useCallback(() => {
		ocrResultActionRef.current?.startTranslate();
	}, []);

	const intl = useIntl();
	const { message } = useContext(AntdContext);

	const [visionModelHtmlLoading, setVisionModelHtmlLoading] = useState(false);
	const [visionModelMarkdownLoading, setVisionModelMarkdownLoading] =
		useState(false);
	const onConvertImageToVisionModelFormat = useCallback(
		async (format: "html" | "markdown") => {
			if (format === "html") {
				setVisionModelHtmlLoading(true);
			} else if (format === "markdown") {
				setVisionModelMarkdownLoading(true);
			} else {
				return;
			}

			const selectRectParams =
				selectLayerActionRef.current?.getSelectRectParams();
			const imageLayerAction = imageLayerActionRef.current;
			const drawLayerAction = drawLayerActionRef.current;
			if (!selectRectParams || !imageLayerAction || !drawLayerAction) {
				return;
			}

			if (
				selectRectParams.rect.max_x - selectRectParams.rect.min_x < 10 ||
				selectRectParams.rect.max_y - selectRectParams.rect.min_y < 10
			) {
				message.error(
					intl.formatMessage({ id: "draw.ocrResult.imageTooSmall" }),
				);
				return;
			}

			const screenshotCanvas = await getCanvas(
				selectRectParams,
				imageLayerAction,
				drawLayerAction,
				true,
				true,
				INIT_CONTAINER_KEY,
			);

			if (!screenshotCanvas) {
				return;
			}

			if (format === "html") {
				await ocrResultActionRef.current?.convertImageToHtml(screenshotCanvas);
				setVisionModelHtmlLoading(false);
			} else if (format === "markdown") {
				await ocrResultActionRef.current?.convertImageToMarkdown(
					screenshotCanvas,
				);
				setVisionModelMarkdownLoading(false);
			}
		},
		[
			selectLayerActionRef,
			imageLayerActionRef,
			drawLayerActionRef,
			intl,
			message,
		],
	);

	const [currentOcrResult, setCurrentOcrResult] = useState<
		(AppOcrResult & { ocrResultType: OcrResultType }) | undefined
	>(undefined);
	const [ocrResult, setOcrResult] = useState<AppOcrResult | undefined>(
		undefined,
	);
	const [translatedOcrResult, setTranslatedOcrResult] = useState<
		AppOcrResult | undefined
	>(undefined);
	const [translateLoading, setTranslateLoading] = useState(false);
	const onSwitchOcrResult = useCallback((ocrResultType: OcrResultType) => {
		ocrResultActionRef.current?.switchOcrResult(ocrResultType);
	}, []);
	const [visionModelHtmlResult, setVisionModelHtmlResult] = useState<
		AppOcrResult | undefined
	>(undefined);
	const [visionModelMarkdownResult, setVisionModelMarkdownResult] = useState<
		AppOcrResult | undefined
	>(undefined);

	const onConvertImageToHtml = useCallback(() => {
		onConvertImageToVisionModelFormat("html");
	}, [onConvertImageToVisionModelFormat]);
	const onConvertImageToMarkdown = useCallback(() => {
		onConvertImageToVisionModelFormat("markdown");
	}, [onConvertImageToVisionModelFormat]);

	const onTranslateOcrToPage = useCallback(() => {
		if (!ocrResult?.result) {
			return;
		}
		const text = covertOcrResultToText(ocrResult.result);
		executeTranslateOcrText(text);
	}, [ocrResult]);

	const { isReadyStatus } = usePluginServiceContext();

	return (
		<>
			{(isReadyStatus?.(PLUGIN_ID_TRANSLATE) ||
				isReadyStatus?.(PLUGIN_ID_AI_CHAT)) && (
				<OcrTool
					onSwitchOcrResult={onSwitchOcrResult}
					onTranslate={onTranslate}
					onTranslateOcrToPage={onTranslateOcrToPage}
					onConvertImageToHtml={onConvertImageToHtml}
					onConvertImageToMarkdown={onConvertImageToMarkdown}
					currentOcrResult={currentOcrResult}
					ocrResult={ocrResult}
					translatedOcrResult={translatedOcrResult}
					translateLoading={translateLoading}
					visionModelHtmlResult={visionModelHtmlResult}
					visionModelHtmlLoading={visionModelHtmlLoading}
					visionModelMarkdownResult={visionModelMarkdownResult}
					visionModelMarkdownLoading={visionModelMarkdownLoading}
				/>
			)}

			<OcrResult
				zIndex={zIndexs.Draw_OcrResult}
				actionRef={ocrResultActionRef}
				onOcrDetect={onOcrDetect}
				onCurrentOcrResultChange={setCurrentOcrResult}
				onOcrResultChange={setOcrResult}
				onTranslatedResultChange={setTranslatedOcrResult}
				onTranslateLoading={setTranslateLoading}
				onVisionModelHtmlResultChange={setVisionModelHtmlResult}
				onVisionModelMarkdownResultChange={setVisionModelMarkdownResult}
				onVisionModelMarkdownLoading={setVisionModelMarkdownLoading}
			/>
		</>
	);
};
