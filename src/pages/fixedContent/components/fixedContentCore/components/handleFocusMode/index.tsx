import { getCurrentWindow } from "@tauri-apps/api/window";
import React, {
	useContext,
	useEffect,
	useRef,
} from "react";
import { EventListenerContext } from "@/components/eventListener";
import {
	FIXED_CONTENT_FOCUS_MODE_CLOSE_ALL_WINDOW,
	FIXED_CONTENT_FOCUS_MODE_CLOSE_OTHER_WINDOW,
	FIXED_CONTENT_FOCUS_MODE_HIDE_OTHER_WINDOW,
	FIXED_CONTENT_FOCUS_MODE_SHOW_ALL_WINDOW,
	TOGGLE_FIXED_CONTENT_VISIBILITY,
} from "@/functions/fixedContent";

const HandleFocusModeCore: React.FC<{
	disabled?: boolean;
	onToggleVisibility?: (visible: boolean) => void;
	onShowSticker?: () => void;
}> = ({ disabled, onToggleVisibility, onShowSticker }) => {
	const { addListener, removeListener } = useContext(EventListenerContext);

	// 始终持有最新的 onShowSticker，避免监听器闭包过期
	const onShowStickerRef = useRef(onShowSticker);
	onShowStickerRef.current = onShowSticker;

	// Toggle visibility 监听器不受 disabled 控制，否则隐藏后无法恢复
	useEffect(() => {
		const toggleVisibilityListenerId = addListener(
			TOGGLE_FIXED_CONTENT_VISIBILITY,
			(args) => {
				const payload = args as {
					payload: { visible: boolean };
				};
				if (onToggleVisibility) {
					onToggleVisibility(payload.payload.visible);
					return;
				}

				const currentWindow = getCurrentWindow();
				if (payload.payload.visible) {
					currentWindow.show();
					onShowStickerRef.current?.();
				} else {
					currentWindow.hide();
				}
			},
		);

		return () => {
			removeListener(toggleVisibilityListenerId);
		};
	}, [addListener, removeListener, onToggleVisibility]);

	useEffect(() => {
		if (disabled) {
			return;
		}

		const currentWindow = getCurrentWindow();

		const showAllWindowListenerId = addListener(
			FIXED_CONTENT_FOCUS_MODE_SHOW_ALL_WINDOW,
			() => {
				currentWindow.show();
				onShowStickerRef.current?.();
			},
		);
		const hideOtherWindowListenerId = addListener(
			FIXED_CONTENT_FOCUS_MODE_HIDE_OTHER_WINDOW,
			(args) => {
				const payload = (args as { payload: { windowLabel: string } }).payload;

				if (payload.windowLabel === currentWindow.label) {
					return;
				}
				currentWindow.hide();
			},
		);
		const closeOtherWindowListenerId = addListener(
			FIXED_CONTENT_FOCUS_MODE_CLOSE_OTHER_WINDOW,
			(args) => {
				const payload = (args as { payload: { windowLabel: string } }).payload;

				if (payload.windowLabel === currentWindow.label) {
					return;
				}
				currentWindow.close();
			},
		);
		const closeAllWindowListenerId = addListener(
			FIXED_CONTENT_FOCUS_MODE_CLOSE_ALL_WINDOW,
			() => {
				currentWindow.close();
			},
		);

		return () => {
			removeListener(showAllWindowListenerId);
			removeListener(hideOtherWindowListenerId);
			removeListener(closeOtherWindowListenerId);
			removeListener(closeAllWindowListenerId);
		};
	}, [addListener, removeListener, disabled]);

	return undefined;
};

export const HandleFocusMode = React.memo(HandleFocusModeCore);
