export interface ZoomPoint {
	x: number;
	y: number;
}

export interface ZoomSize {
	width: number;
	height: number;
}

export interface ZoomAnchor {
	client: ZoomPoint;
	focal: ZoomPoint;
}

interface RectLike extends ZoomSize {
	left: number;
	top: number;
}

interface FitScaleOptions {
	viewport: ZoomSize;
	content: ZoomSize;
	padding: number;
	minScale: number;
	maxScale: number;
	upscale?: boolean;
}

export function clampZoomScale(scale: number, minScale: number, maxScale: number): number {
	return Math.max(minScale, Math.min(maxScale, scale));
}

export function calculateFitScale({
	viewport,
	content,
	padding,
	minScale,
	maxScale,
	upscale = false,
}: FitScaleOptions): number {
	const availableWidth = Math.max(1, viewport.width - padding * 2);
	const availableHeight = Math.max(1, viewport.height - padding * 2);
	const widthScale = availableWidth / Math.max(1, content.width);
	const heightScale = availableHeight / Math.max(1, content.height);
	const fitScale = Math.min(widthScale, heightScale, upscale ? maxScale : 1);
	return clampZoomScale(fitScale, minScale, maxScale);
}

export function centerOfRect(rect: RectLike): ZoomPoint {
	return {
		x: rect.left + rect.width / 2,
		y: rect.top + rect.height / 2,
	};
}

export function midpoint(first: ZoomPoint, second: ZoomPoint): ZoomPoint {
	return {
		x: (first.x + second.x) / 2,
		y: (first.y + second.y) / 2,
	};
}

export function distance(first: ZoomPoint, second: ZoomPoint): number {
	return Math.hypot(second.x - first.x, second.y - first.y);
}

export function captureZoomAnchor(
	viewportRect: RectLike,
	contentRect: RectLike,
	client: ZoomPoint = centerOfRect(viewportRect),
	fallback: ZoomPoint = { x: 0.5, y: 0.5 },
): ZoomAnchor {
	return {
		client,
		focal: {
			x:
				contentRect.width > 0
					? clampZoomScale((client.x - contentRect.left) / contentRect.width, 0, 1)
					: fallback.x,
			y:
				contentRect.height > 0
					? clampZoomScale((client.y - contentRect.top) / contentRect.height, 0, 1)
					: fallback.y,
		},
	};
}

export function restoreZoomAnchor(
	viewport: Pick<HTMLElement, 'scrollLeft' | 'scrollTop'>,
	contentRect: RectLike,
	anchor: ZoomAnchor,
): void {
	const focalClientX = contentRect.left + contentRect.width * anchor.focal.x;
	const focalClientY = contentRect.top + contentRect.height * anchor.focal.y;
	viewport.scrollLeft += focalClientX - anchor.client.x;
	viewport.scrollTop += focalClientY - anchor.client.y;
}
