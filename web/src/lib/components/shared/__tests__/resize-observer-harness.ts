export class ResizeObserverHarness implements ResizeObserver {
	static instances: ResizeObserverHarness[] = [];

	readonly observed = new Set<Element>();
	readonly callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		ResizeObserverHarness.instances.push(this);
	}

	observe(target: Element): void {
		this.observed.add(target);
	}

	unobserve(target: Element): void {
		this.observed.delete(target);
	}

	disconnect(): void {
		this.observed.clear();
	}

	static emit(target: Element, width: number, height = 0): void {
		const observers = ResizeObserverHarness.instances.filter((candidate) =>
			candidate.observed.has(target),
		);
		if (observers.length === 0)
			throw new Error('No ResizeObserver is watching the target element.');
		for (const observer of observers) {
			ResizeObserverHarness.emitFrom(observer, target, width, height);
		}
	}

	static emitFrom(
		observer: ResizeObserverHarness,
		target: Element,
		width: number,
		height = 0,
	): void {
		ResizeObserverHarness.emitBatch(observer, [{ target, width, height }]);
	}

	static emitBatch(
		observer: ResizeObserverHarness,
		sizes: readonly { target: Element; width: number; height?: number }[],
	): void {
		observer.callback(
			sizes.map(({ target, width, height = 0 }) =>
				ResizeObserverHarness.entry(target, width, height),
			),
			observer,
		);
	}

	private static entry(target: Element, width: number, height: number): ResizeObserverEntry {
		const contentRect = {
			x: 0,
			y: 0,
			width,
			height,
			top: 0,
			right: width,
			bottom: height,
			left: 0,
			toJSON: () => ({ width, height }),
		} satisfies DOMRectReadOnly;
		const boxSize = { inlineSize: width, blockSize: height } satisfies ResizeObserverSize;
		return {
			target,
			contentRect,
			borderBoxSize: [boxSize],
			contentBoxSize: [boxSize],
			devicePixelContentBoxSize: [boxSize],
		};
	}
}

export function installResizeObserverHarness(): () => void {
	const original = globalThis.ResizeObserver;
	ResizeObserverHarness.instances = [];
	globalThis.ResizeObserver = ResizeObserverHarness;
	return () => {
		ResizeObserverHarness.instances = [];
		globalThis.ResizeObserver = original;
	};
}
