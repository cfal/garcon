import {
	calculateFitScale,
	captureZoomAnchor,
	clampZoomScale,
	distance,
	midpoint,
	restoreZoomAnchor,
	type ZoomAnchor,
	type ZoomPoint,
	type ZoomSize,
} from './zoom-viewport.js';

export interface ZoomViewportView {
	mode: 'fit' | 'manual';
	scale: number;
}

interface ZoomViewportOptions {
	readonly viewport: HTMLElement | null;
	readonly content: Element | null;
	readonly view: ZoomViewportView;
	readContentSize: () => ZoomSize | null;
	padding: number;
	minScale: number;
	maxScale: number;
	fitMinScale?: number;
	input: 'native-scroll' | 'pointer-gestures';
	onAnchorRestored?: (viewport: HTMLElement) => void;
}

export class ZoomViewportController {
	#viewportSize = $state<ZoomSize>({ width: 1, height: 1 });
	#contentSize = $state<ZoomSize>({ width: 0, height: 0 });
	#fitMin = $state<number | null>(null);
	#frame: number | null = null;
	#pendingAnchor: ZoomAnchor | null = null;
	#pointers = new Map<number, ZoomPoint>();
	#pan: { pointerId: number; origin: ZoomPoint; scroll: ZoomPoint } | null = null;
	#pinch: {
		pointerIds: [number, number];
		distance: number;
		scale: number;
		focal: ZoomPoint;
	} | null = null;
	dragging = $state(false);
	pinching = $state(false);

	constructor(private readonly options: ZoomViewportOptions) {}

	get scale() { return this.options.view.scale; }
	get minScale() { return Math.min(this.options.minScale, this.#fitMin ?? Infinity); }
	get stageWidth() { return this.#contentSize.width * this.scale; }
	get stageHeight() { return this.#contentSize.height * this.scale; }
	get canvasWidth() {
		return Math.max(this.#viewportSize.width, this.stageWidth + this.options.padding * 2);
	}
	get canvasHeight() {
		return Math.max(this.#viewportSize.height, this.stageHeight + this.options.padding * 2);
	}
	get stageLeft() { return (this.canvasWidth - this.stageWidth) / 2; }
	get stageTop() { return (this.canvasHeight - this.stageHeight) / 2; }
	get canPan() {
		return this.canvasWidth > this.#viewportSize.width || this.canvasHeight > this.#viewportSize.height;
	}

	updateGeometry(): boolean {
		const viewport = this.options.viewport;
		if (!viewport) return false;
		const width = Math.max(1, viewport.clientWidth);
		const height = Math.max(1, viewport.clientHeight);
		if (width !== this.#viewportSize.width || height !== this.#viewportSize.height)
			this.#viewportSize = { width, height };
		const content = this.options.readContentSize();
		if (!content) return false;
		if (content.width !== this.#contentSize.width || content.height !== this.#contentSize.height)
			this.#contentSize = content;
		return true;
	}

	fit(): boolean {
		if (!this.updateGeometry()) return false;
		this.cancelCorrection();
		const { view, padding, minScale, maxScale, fitMinScale } = this.options;
		view.mode = 'fit';
		view.scale = calculateFitScale({
			viewport: this.#viewportSize,
			content: this.#contentSize,
			padding,
			minScale: fitMinScale ?? minScale,
			maxScale,
		});
		this.#fitMin = view.scale;
		return true;
	}

	centerAfterLayout(): void {
		this.cancelCorrection();
		this.#frame = requestAnimationFrame(() => {
			this.#frame = null;
			const viewport = this.options.viewport;
			if (!viewport) return;
			viewport.scrollTo({
				left: Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2),
				top: Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2),
			});
		});
	}

	zoomBy(delta: number): void {
		this.#zoomAt(this.scale + delta);
	}

	wheel(event: WheelEvent): void {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		this.#zoomAt(this.scale * Math.exp(-event.deltaY * 0.002), {
			x: event.clientX,
			y: event.clientY,
		});
	}

	#zoomAt(scale: number, client?: ZoomPoint): void {
		const view = this.options.view;
		const next = clampZoomScale(scale, this.minScale, this.options.maxScale);
		if (next === view.scale && this.options.input === 'pointer-gestures') return;
		const anchor = this.options.input === 'native-scroll' && this.#pendingAnchor
			? this.#pendingAnchor
			: this.captureAnchor(client);
		view.mode = 'manual';
		view.scale = next;
		this.restoreAfterLayout(anchor);
	}

	captureAnchor(client?: ZoomPoint): ZoomAnchor | null {
		const { viewport, content } = this.options;
		return viewport && content
			? captureZoomAnchor(viewport.getBoundingClientRect(), content.getBoundingClientRect(), client)
			: null;
	}

	restoreAfterLayout(anchor: ZoomAnchor | null): void {
		if (!anchor) return;
		if (this.#pendingAnchor) {
			if (this.options.input === 'pointer-gestures')
				this.#pendingAnchor = { client: anchor.client, focal: this.#pendingAnchor.focal };
			return;
		}
		this.cancelCorrection();
		this.#pendingAnchor = anchor;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = null;
			this.#restoreAnchor();
		});
	}

	#restoreAnchor(): void {
		const anchor = this.#pendingAnchor;
		this.cancelCorrection();
		const { viewport, content } = this.options;
		if (!anchor || !viewport || !content) return;
		restoreZoomAnchor(viewport, content.getBoundingClientRect(), anchor);
		this.options.onAnchorRestored?.(viewport);
	}

	cancelCorrection(): void {
		if (this.#frame !== null) cancelAnimationFrame(this.#frame);
		this.#frame = null;
		this.#pendingAnchor = null;
	}

	reset(): void {
		this.cancelCorrection();
		this.clearPointers();
		this.#fitMin = null;
		this.options.view.mode = 'fit';
		this.options.view.scale = 1;
	}

	observe(viewport: HTMLElement, initialize: () => void, resize: () => void): () => void {
		let resizeFrame: number | null = null;
		const observer = new ResizeObserver(() => {
			if (resizeFrame !== null) return;
			resizeFrame = requestAnimationFrame(() => {
				resizeFrame = null;
				resize();
			});
		});
		observer.observe(viewport);
		const frame = requestAnimationFrame(initialize);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
			this.cancelCorrection();
			this.clearPointers(viewport);
		};
	}

	pointerDown(event: PointerEvent): void {
		const viewport = this.options.viewport;
		if (!viewport || (event.pointerType === 'mouse' && event.button !== 0)) return;
		if (event.composedPath().some((target) => target instanceof Element && target.localName === 'a'))
			return;
		if (this.#pointers.size === 0 && this.#pendingAnchor) this.#restoreAnchor();
		const point = { x: event.clientX, y: event.clientY };
		this.#pointers.set(event.pointerId, point);
		viewport.setPointerCapture(event.pointerId);
		if (this.#pointers.size === 2) this.#startPinch();
		else if (this.#pointers.size === 1) this.#startPan(event.pointerId, point);
	}

	#startPan(pointerId: number, origin: ZoomPoint): void {
		const viewport = this.options.viewport;
		if (!viewport) return;
		this.#pan = { pointerId, origin, scroll: { x: viewport.scrollLeft, y: viewport.scrollTop } };
		this.dragging = this.canPan;
	}

	#startPinch(): void {
		const [first, second] = this.#pointers;
		if (!first || !second) return;
		const anchor = this.captureAnchor(midpoint(first[1], second[1]));
		if (!anchor) return;
		this.#pinch = {
			pointerIds: [first[0], second[0]],
			distance: Math.max(1, distance(first[1], second[1])),
			scale: this.scale,
			focal: anchor.focal,
		};
		this.#pan = null;
		this.dragging = false;
		this.pinching = true;
	}

	pointerMove(event: PointerEvent): void {
		const viewport = this.options.viewport;
		if (!viewport || !this.#pointers.has(event.pointerId)) return;
		const point = { x: event.clientX, y: event.clientY };
		this.#pointers.set(event.pointerId, point);
		if (this.#pinch) {
			const [firstId, secondId] = this.#pinch.pointerIds;
			const first = this.#pointers.get(firstId);
			const second = this.#pointers.get(secondId);
			if (!first || !second) return;
			const { view, maxScale } = this.options;
			view.mode = 'manual';
			view.scale = clampZoomScale(
				this.#pinch.scale * (distance(first, second) / this.#pinch.distance),
				this.minScale,
				maxScale,
			);
			this.restoreAfterLayout({ client: midpoint(first, second), focal: this.#pinch.focal });
		} else if (this.#pan?.pointerId === event.pointerId && this.dragging) {
			viewport.scrollLeft = this.#pan.scroll.x - (point.x - this.#pan.origin.x);
			viewport.scrollTop = this.#pan.scroll.y - (point.y - this.#pan.origin.y);
		}
	}

	removePointer(pointerId: number, releaseCapture: boolean): void {
		if (!this.#pointers.delete(pointerId)) return;
		const viewport = this.options.viewport;
		if (releaseCapture && viewport?.hasPointerCapture(pointerId))
			viewport.releasePointerCapture(pointerId);
		if (this.#pinch?.pointerIds.includes(pointerId)) {
			this.#pinch = null;
			this.pinching = false;
			if (this.#pointers.size > 0) this.#restoreAnchor();
			if (this.#pointers.size >= 2) this.#startPinch();
			else {
				const remaining = this.#pointers.entries().next().value;
				if (remaining) this.#startPan(...remaining);
			}
		} else if (this.#pan?.pointerId === pointerId) {
			this.#pan = null;
			this.dragging = false;
		}
	}

	clearPointers(viewport = this.options.viewport): void {
		const pointerIds = [...this.#pointers.keys()];
		this.#pointers.clear();
		this.#pan = null;
		this.#pinch = null;
		this.dragging = false;
		this.pinching = false;
		for (const pointerId of pointerIds) {
			if (viewport?.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
		}
	}
}
