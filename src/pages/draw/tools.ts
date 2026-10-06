import {
	getWebViewSharedBuffer,
	releaseWebViewSharedBuffer,
} from "@/utils/webview";

export type ImageSharedBufferData = {
	sharedBuffer: Uint8ClampedArray<ArrayBuffer>;
	width: number;
	height: number;
};

export const getImageBufferFromSharedBuffer = async (
	transferType: string,
	manualRelease: boolean = false,
	timeoutMs: number = 1000 * 3,
): Promise<ImageSharedBufferData | undefined> => {
	const data = await getWebViewSharedBuffer(undefined, transferType, timeoutMs);
	if (!data) {
		return undefined;
	}

	const buffer = data;
	const imageExtraInfoBytesLength = 8;
	const imageBytesLength = buffer.byteLength - imageExtraInfoBytesLength;
	const width = new DataView(buffer, imageBytesLength, 4).getUint32(0, true);
	const height = new DataView(buffer, imageBytesLength + 4, 4).getUint32(
		0,
		true,
	);

	const result = {
		sharedBuffer: manualRelease
			? new Uint8ClampedArray(buffer, 0, imageBytesLength)
			: new Uint8ClampedArray(buffer.slice(0, imageBytesLength)),
		width,
		height,
	};

	if (!manualRelease) {
		releaseWebViewSharedBuffer(buffer);
	}
	return result;
};
