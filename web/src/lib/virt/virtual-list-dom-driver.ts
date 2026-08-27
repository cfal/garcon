import type { Attachment } from 'svelte/attachments';
import type { VirtualListEnvironment } from './virtual-list-environment';

export interface VirtualDomGeometry {
	readonly scrollTop: number;
	readonly viewportSize: number;
	readonly leadingOffset: number;
	readonly physicalMaximum: number;
	readonly inPhysicalBounds: boolean;
}

export interface VirtualElementMeasurement {
	readonly key: string;
	readonly element: HTMLElement;
	readonly size: number;
}

export interface VirtualListDomDriverOptions {
	readonly environment: VirtualListEnvironment;
	readonly initialViewportSize: number;
	measureElement?(element: HTMLElement, entry: ResizeObserverEntry | undefined): number | null;
	shouldMeasureMount(key: string): boolean;
	onMount(measurements: readonly VirtualElementMeasurement[]): void;
	onResize(measurements: readonly VirtualElementMeasurement[]): void;
	onViewportResize(): void;
	onScroll(): void;
	onUserIntent(): void;
}

// Matches TanStack Virtual's deliberate CSS-pixel rounding before the offsetHeight fallback.
// https://github.com/TanStack/virtual/blob/e9874f033c74afd3251eeb9f3e60b2530cc7ae88/packages/virtual-core/src/index.ts#L259-L286
function blockSize(entry: ResizeObserverEntry | undefined, element: HTMLElement): number {
	return Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight);
}

export class VirtualListDomDriver {
	readonly viewport: Attachment<HTMLElement>;
	readonly sizer: Attachment<HTMLElement>;

	#viewportElement: HTMLElement | null = null;
	#sizerElement: HTMLElement | null = null;
	#elementsByKey = new Map<string, HTMLElement>();
	#keysByElement = new WeakMap<HTMLElement, string>();
	#attachmentsByKey = new Map<string, Attachment<HTMLElement>>();
	#pendingMounts = new Map<string, HTMLElement>();
	#ignoredEntries = 0;
	#observer: ResizeObserver;
	#mountQueued = false;
	#viewportObserved = false;
	#suspended = false;
	#destroyed = false;

	constructor(private readonly options: VirtualListDomDriverOptions) {
		this.#observer = options.environment.createResizeObserver((entries) => {
			this.#handleObserver(entries);
		});
		this.viewport = (element) => this.#attachViewport(element);
		this.sizer = (element) => this.#attachSizer(element);
	}

	item(key: string): Attachment<HTMLElement> {
		let attachment = this.#attachmentsByKey.get(key);
		if (attachment) return attachment;
		attachment = (element) => this.#attachItem(key, element);
		this.#attachmentsByKey.set(key, attachment);
		return attachment;
	}

	read(): VirtualDomGeometry | null {
		const viewport = this.#viewportElement;
		const sizer = this.#sizerElement;
		if (!viewport || !sizer || this.#suspended) return null;
		const scrollTop = viewport.scrollTop;
		const physicalViewportSize = viewport.clientHeight;
		const viewportSize = this.#viewportObserved
			? physicalViewportSize
			: this.options.initialViewportSize;
		const scrollHeight = viewport.scrollHeight;
		const leadingOffset =
			sizer.getBoundingClientRect().top - viewport.getBoundingClientRect().top + scrollTop;
		const physicalMaximum = Math.max(0, scrollHeight - physicalViewportSize);
		return {
			scrollTop,
			viewportSize,
			leadingOffset,
			physicalMaximum,
			inPhysicalBounds: !this.#viewportObserved || (scrollTop >= 0 && scrollTop <= physicalMaximum),
		};
	}

	writeScrollTop(offset: number): number {
		const viewport = this.#viewportElement;
		if (!viewport || this.#suspended) return 0;
		viewport.scrollTop = offset;
		return viewport.scrollTop;
	}

	measureElement(element: HTMLElement): VirtualElementMeasurement | null {
		const key = this.#keysByElement.get(element);
		if (!key || this.#elementsByKey.get(key) !== element || !element.isConnected) return null;
		return this.#measurement(key, element);
	}

	measureAll(): readonly VirtualElementMeasurement[] {
		const measurements: VirtualElementMeasurement[] = [];
		for (const [key, element] of this.#elementsByKey) {
			if (!element.isConnected) continue;
			const measurement = this.#measurement(key, element);
			if (measurement) measurements.push(measurement);
		}
		return measurements;
	}

	recordIgnoredEntries(count: number): void {
		this.#ignoredEntries += count;
	}

	drainIgnoredEntries(): number {
		const ignoredEntries = this.#ignoredEntries;
		this.#ignoredEntries = 0;
		return ignoredEntries;
	}

	pruneKeys(hasKey: (key: string) => boolean): void {
		for (const [key, element] of this.#elementsByKey) {
			if (hasKey(key)) continue;
			this.#observer.unobserve(element);
			this.#elementsByKey.delete(key);
			this.#pendingMounts.delete(key);
		}
		for (const key of this.#attachmentsByKey.keys())
			if (!hasKey(key)) this.#attachmentsByKey.delete(key);
	}

	clearItems(): void {
		for (const element of this.#elementsByKey.values()) this.#observer.unobserve(element);
		this.#elementsByKey.clear();
		this.#pendingMounts.clear();
		this.#attachmentsByKey.clear();
		this.#keysByElement = new WeakMap();
	}

	suspend(): void {
		if (this.#suspended) return;
		this.#suspended = true;
		this.#unobserveAll();
		this.#removeViewportListeners();
	}

	resume(): void {
		if (!this.#suspended || this.#destroyed) return;
		this.#suspended = false;
		this.#observeAll();
		this.#addViewportListeners();
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#removeViewportListeners();
		this.#observer.disconnect();
		this.#viewportElement = null;
		this.#sizerElement = null;
		this.clearItems();
	}

	#attachViewport(element: HTMLElement): void | (() => void) {
		if (this.#destroyed) return;
		this.#viewportElement = element;
		this.#viewportObserved = false;
		if (!this.#suspended) {
			this.#observer.observe(element);
			this.#addViewportListeners();
			this.options.environment.queueMicrotask(() => this.options.onViewportResize());
		}
		return () => {
			if (this.#viewportElement !== element) return;
			this.#removeViewportListeners();
			this.#observer.unobserve(element);
			this.#viewportElement = null;
		};
	}

	#attachSizer(element: HTMLElement): void | (() => void) {
		if (this.#destroyed) return;
		this.#sizerElement = element;
		this.options.environment.queueMicrotask(() => this.options.onViewportResize());
		return () => {
			if (this.#sizerElement === element) this.#sizerElement = null;
		};
	}

	#attachItem(key: string, element: HTMLElement): void | (() => void) {
		if (this.#destroyed) return;
		const previous = this.#elementsByKey.get(key);
		if (previous && previous !== element) this.#observer.unobserve(previous);
		this.#elementsByKey.set(key, element);
		this.#keysByElement.set(element, key);
		if (!this.#suspended) this.#observer.observe(element, { box: 'border-box' });
		if (this.options.shouldMeasureMount(key)) {
			this.#pendingMounts.set(key, element);
			this.#queueMountMeasurement();
		}
		return () => {
			if (this.#elementsByKey.get(key) !== element) return;
			this.#observer.unobserve(element);
			this.#elementsByKey.delete(key);
			this.#pendingMounts.delete(key);
		};
	}

	#queueMountMeasurement(): void {
		if (this.#mountQueued) return;
		this.#mountQueued = true;
		this.options.environment.queueMicrotask(() => {
			this.#mountQueued = false;
			if (this.#destroyed || this.#suspended || !this.#viewportObserved) return;
			const measurements: VirtualElementMeasurement[] = [];
			for (const [key, element] of this.#pendingMounts) {
				if (this.#elementsByKey.get(key) !== element || !element.isConnected) continue;
				const measurement = this.#measurement(key, element);
				if (measurement) measurements.push(measurement);
			}
			this.#pendingMounts.clear();
			if (measurements.length > 0) this.options.onMount(measurements);
		});
	}

	#handleObserver(entries: readonly ResizeObserverEntry[]): void {
		if (this.#destroyed || this.#suspended) return;
		const viewportEntry = entries.find((entry) => entry.target === this.#viewportElement);
		this.#viewportObserved ||=
			(viewportEntry?.borderBoxSize[0]?.blockSize ?? viewportEntry?.contentRect.height ?? 0) > 0;
		let viewportChanged = false;
		const measurements: VirtualElementMeasurement[] = [];
		for (const entry of entries) {
			if (entry.target === this.#viewportElement) {
				viewportChanged = true;
				continue;
			}
			const element = entry.target instanceof HTMLElement ? entry.target : null;
			const key = element ? this.#keysByElement.get(element) : undefined;
			if (!element || !key || this.#elementsByKey.get(key) !== element || !element.isConnected) {
				this.#ignoredEntries += 1;
				continue;
			}
			if (!this.#viewportObserved) continue;
			const measurement = this.#measurement(key, element, entry);
			if (measurement) {
				measurements.push(measurement);
				this.#pendingMounts.delete(key);
			}
		}
		if (measurements.length > 0) this.options.onResize(measurements);
		if (viewportChanged) this.options.onViewportResize();
		if (this.#viewportObserved && this.#pendingMounts.size > 0) this.#queueMountMeasurement();
	}

	#measurement(
		key: string,
		element: HTMLElement,
		entry?: ResizeObserverEntry,
	): VirtualElementMeasurement | null {
		const size = this.options.measureElement
			? this.options.measureElement(element, entry)
			: blockSize(entry, element);
		return size === null ? null : { key, element, size };
	}

	#observeAll(): void {
		if (this.#viewportElement) this.#observer.observe(this.#viewportElement);
		for (const element of this.#elementsByKey.values())
			this.#observer.observe(element, { box: 'border-box' });
	}

	#unobserveAll(): void {
		if (this.#viewportElement) this.#observer.unobserve(this.#viewportElement);
		for (const element of this.#elementsByKey.values()) this.#observer.unobserve(element);
	}

	#addViewportListeners(): void {
		this.#viewportElement?.addEventListener('scroll', this.#handleScroll, { passive: true });
		this.#viewportElement?.addEventListener('wheel', this.#handleUserIntent, { passive: true });
		this.#viewportElement?.addEventListener('pointerdown', this.#handleUserIntent, {
			passive: true,
		});
		this.#viewportElement?.addEventListener('keydown', this.#handleUserIntent);
	}

	#removeViewportListeners(): void {
		this.#viewportElement?.removeEventListener('scroll', this.#handleScroll);
		this.#viewportElement?.removeEventListener('wheel', this.#handleUserIntent);
		this.#viewportElement?.removeEventListener('pointerdown', this.#handleUserIntent);
		this.#viewportElement?.removeEventListener('keydown', this.#handleUserIntent);
	}

	#handleScroll = (): void => this.options.onScroll();
	#handleUserIntent = (): void => this.options.onUserIntent();
}
