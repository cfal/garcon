export interface ImageDimensions {
	width: number;
	height: number;
}

export function decodeFileImage(url: string, signal: AbortSignal): Promise<ImageDimensions> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		function cleanup(): void {
			signal.removeEventListener('abort', abort);
			image.removeAttribute('src');
		}
		function abort(): void {
			cleanup();
			reject(signal.reason);
		}
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener('abort', abort, { once: true });
		image.src = url;
		image.decode().then(
			() => {
				const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
				cleanup();
				resolve(dimensions);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}
