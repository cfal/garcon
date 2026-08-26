import { VirtualListController } from '../virtual-list-controller.svelte';
import type { VirtualListEnvironment } from '../virtual-list-environment';
import type { VirtualTransactionRecord } from '../virtual-list-types';

class TestResizeObserver implements ResizeObserver {
	readonly observed = new Set<Element>();

	constructor(private readonly callback: ResizeObserverCallback) {}

	observe(target: Element): void {
		this.observed.add(target);
	}

	unobserve(target: Element): void {
		this.observed.delete(target);
	}

	disconnect(): void {
		this.observed.clear();
	}

	emit(target: Element, height: number): void {
		const size = { inlineSize: 100, blockSize: height } satisfies ResizeObserverSize;
		this.callback(
			[
				{
					target,
					contentRect: target.getBoundingClientRect(),
					borderBoxSize: [size],
					contentBoxSize: [size],
					devicePixelContentBoxSize: [size],
				} satisfies ResizeObserverEntry,
			],
			this,
		);
	}
}

class TestEnvironment implements VirtualListEnvironment {
	readonly microtasks: Array<() => void> = [];
	readonly frames = new Map<number, FrameRequestCallback>();
	observer!: TestResizeObserver;
	#nextFrame = 1;
	#time = 0;

	now(): number {
		return this.#time++;
	}

	queueMicrotask(callback: () => void): void {
		this.microtasks.push(callback);
	}

	requestAnimationFrame(callback: FrameRequestCallback): number {
		const handle = this.#nextFrame++;
		this.frames.set(handle, callback);
		return handle;
	}

	cancelAnimationFrame(handle: number): void {
		this.frames.delete(handle);
	}

	createResizeObserver(callback: ResizeObserverCallback): ResizeObserver {
		this.observer = new TestResizeObserver(callback);
		return this.observer;
	}

	flushMicrotasks(): void {
		while (this.microtasks.length > 0) this.microtasks.shift()?.();
	}

	flushFrames(): void {
		const frames = [...this.frames.values()];
		this.frames.clear();
		for (const frame of frames) frame(this.now());
	}
}

export function createVirtualListHarness(options?: {
	viewportSize?: number;
	overscan?: number;
	measurementAnchor?: 'geometric' | 'end';
	measureElement?(element: HTMLElement, entry: ResizeObserverEntry | undefined): number | null;
}) {
	const environment = new TestEnvironment();
	const records: VirtualTransactionRecord[] = [];
	let viewportSize = options?.viewportSize ?? 100;
	let leadingOffset = 0;
	let physicalScrollTop = 0;
	let writes = 0;
	const controller = new VirtualListController({
		overscan: options?.overscan ?? 1,
		measurementAnchor: options?.measurementAnchor ?? 'geometric',
		measureElement: options?.measureElement,
		environment,
		onTransaction: (record) => records.push(record),
	});
	const viewport = document.createElement('div');
	const sizer = document.createElement('div');
	viewport.append(sizer);
	document.body.append(viewport);

	Object.defineProperties(viewport, {
		clientHeight: { get: () => viewportSize },
		scrollHeight: {
			get: () => Math.max(viewportSize, leadingOffset + controller.snapshot.sizerSize),
		},
		scrollTop: {
			get: () => physicalScrollTop,
			set: (value: number) => {
				writes += 1;
				const maximum = Math.max(0, viewport.scrollHeight - viewportSize);
				physicalScrollTop = Math.max(0, Math.min(value, maximum));
				viewport.dispatchEvent(new Event('scroll'));
			},
		},
	});
	viewport.getBoundingClientRect = () => rect(0, viewportSize);
	sizer.getBoundingClientRect = () =>
		rect(leadingOffset - physicalScrollTop, controller.snapshot.sizerSize);

	const detachViewport = controller.viewport(viewport);
	const detachSizer = controller.sizer(sizer);
	environment.flushMicrotasks();

	return {
		controller,
		environment,
		records,
		sizer,
		viewport,
		get writes() {
			return writes;
		},
		setLeadingOffset(value: number) {
			leadingOffset = value;
		},
		setPhysicalScrollTop(value: number) {
			physicalScrollTop = value;
			viewport.dispatchEvent(new Event('scroll'));
		},
		setViewportSize(value: number) {
			viewportSize = value;
			environment.observer.emit(viewport, value);
		},
		mountItem(key: string, size: number) {
			const element = document.createElement('div');
			Object.defineProperty(element, 'offsetHeight', { get: () => size });
			sizer.append(element);
			const detach = controller.item(key)(element);
			return { element, detach };
		},
		destroy() {
			detachSizer?.();
			detachViewport?.();
			controller.destroy();
			viewport.remove();
		},
	};
}

function rect(top: number, height: number): DOMRect {
	return {
		x: 0,
		y: top,
		width: 100,
		height,
		top,
		right: 100,
		bottom: top + height,
		left: 0,
		toJSON: () => ({}),
	};
}
