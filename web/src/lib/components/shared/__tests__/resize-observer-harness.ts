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

	static emit(target: Element, width: number): void {
		const observer = ResizeObserverHarness.instances.find((candidate) =>
			candidate.observed.has(target),
		);
		if (!observer) throw new Error('No ResizeObserver is watching the target element.');
		const entry = {
			target,
			contentRect: { width },
		} as ResizeObserverEntry;
		observer.callback([entry], observer);
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
