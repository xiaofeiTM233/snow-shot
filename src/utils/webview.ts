import { supportWebViewSharedBuffer } from "./environment";

export const getWebViewSharedBuffer = (
	channelId?: string,
	transferType?: string,
	// 等待超时（毫秒）。排空残留事件时应传极短超时，避免拖慢正常流程
	timeoutMs: number = 1000 * 3,
): Promise<ArrayBuffer | undefined> => {
	if (!supportWebViewSharedBuffer()) {
		return Promise.resolve(undefined);
	}

	// Windows 下支持通过 SharedBuffer 传输图像数据
	return new Promise((resolve) => {
		const handleSharedBufferReceived = (e: {
			getBuffer: () => ArrayBuffer;
			additionalData?: Record<string, unknown>;
		}) => {
			if (transferType && e.additionalData?.transfer_type !== transferType) {
				return;
			}

			if (channelId && e.additionalData?.id !== channelId) {
				return;
			}

			clearTimeout(timeout);

			const buffer = e.getBuffer();

			resolve(buffer);
			window.chrome.webview.removeEventListener(
				"sharedbufferreceived",
				handleSharedBufferReceived,
			);
		};

		window.chrome.webview.addEventListener(
			"sharedbufferreceived",
			handleSharedBufferReceived,
		);

		const timeout = setTimeout(() => {
			resolve(undefined);
			window.chrome.webview.removeEventListener(
				"sharedbufferreceived",
				handleSharedBufferReceived,
			);
		}, timeoutMs);
	});
};

/**
 * 排空可能滞留在事件队列中的 SharedBuffer 事件。
 *
 * WebView2 的 `sharedbufferreceived` 在 JS 事件循环中派发：若主线程繁忙，上一帧的
 * 事件会滞留队列；等待方超时移除监听器后，该事件依然会在之后被派发，并被下一次
 * 截图注册的监听器捕获，导致“快速连续截图时截取到上一次画面”。
 * 采集开始前调用本方法，以极短超时把这类残留事件消费掉。
 */
export const drainWebViewSharedBuffer = (
	transferType: string,
	timeoutMs: number = 50,
): Promise<void> => {
	return getWebViewSharedBuffer(undefined, transferType, timeoutMs).then(
		(buffer) => {
			if (buffer) {
				// 残留帧必须释放，否则会一直占用 WebView2 的共享缓冲区槽位
				releaseWebViewSharedBuffer(buffer);
			}
		},
	);
};

export const releaseWebViewSharedBuffer = (buffer: ArrayBuffer) => {
	if (!supportWebViewSharedBuffer()) {
		return;
	}
	window.chrome.webview.releaseBuffer(buffer);
};
