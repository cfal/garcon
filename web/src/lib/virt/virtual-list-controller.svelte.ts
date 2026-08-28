import type { Attachment } from 'svelte/attachments';
import { VirtualListDomDriver } from './virtual-list-dom-driver';
import {
	browserVirtualListEnvironment,
	type VirtualListEnvironment,
} from './virtual-list-environment';
import { VirtualListTransaction } from './virtual-list-transaction';
import type {
	VirtualIndexScrollResult,
	VirtualItemsMutation,
	VirtualKeyScrollResult,
	VirtualListSnapshot,
	VirtualMutationResult,
	VirtualResumeResult,
	VirtualResumeTarget,
	VirtualScrollActivity,
	VirtualScrollResult,
	VirtualTransactionRecord,
	VirtualViewportPosition,
} from './virtual-list-types';

export interface VirtualListControllerOptions {
	get overscan(): number;
	get measurementAnchor(): 'geometric' | 'end';
	readonly initialViewportSize: number;
	readonly environment?: VirtualListEnvironment;
	measureElement?(element: HTMLElement, entry: ResizeObserverEntry | undefined): number | null;
	onTransaction?(record: VirtualTransactionRecord): void;
}

export class VirtualListController {
	readonly viewport: Attachment<HTMLElement>;
	readonly sizer: Attachment<HTMLElement>;

	#snapshot: VirtualListSnapshot = $state.raw() as VirtualListSnapshot;
	#transaction: VirtualListTransaction;
	#driver: VirtualListDomDriver;

	constructor(options: VirtualListControllerOptions) {
		const environment = options.environment ?? browserVirtualListEnvironment;
		this.#transaction = new VirtualListTransaction({
			environment,
			getOverscan: () => options.overscan,
			getMeasurementAnchor: () => options.measurementAnchor,
			publish: (snapshot) => {
				this.#snapshot = snapshot;
			},
			onTransaction: options.onTransaction,
		});
		this.#snapshot = this.#transaction.snapshot;
		this.#driver = new VirtualListDomDriver({
			environment,
			initialViewportSize: options.initialViewportSize,
			measureElement: options.measureElement,
			shouldMeasureMount: (key) => this.#transaction.geometry.measuredSize(key) === undefined,
			onMount: (measurements) => this.#transaction.measure(measurements, 'mount'),
			onResize: (measurements) => this.#transaction.measure(measurements, 'resize'),
			onViewportResize: () => this.#transaction.viewportChanged(true),
			onScroll: () => this.#transaction.scrolled(),
			onUserIntent: () => this.#transaction.cancelOwnedScroll(),
		});
		this.#transaction.attachDriver(this.#driver);
		this.viewport = this.#driver.viewport;
		this.sizer = this.#driver.sizer;
	}

	get snapshot(): VirtualListSnapshot {
		return this.#snapshot;
	}
	get viewportPosition(): VirtualViewportPosition | null {
		return this.#transaction.viewportPosition;
	}
	get ownsScrollPosition(): boolean {
		return this.#transaction.ownsScroll;
	}
	item(key: string): Attachment<HTMLElement> {
		return this.#driver.item(key);
	}
	measuredSize(key: string): number | undefined {
		return this.#transaction.geometry.measuredSize(key);
	}
	apply(mutation: VirtualItemsMutation): VirtualMutationResult {
		return this.#transaction.apply(mutation);
	}
	setScrollActivity(activity: VirtualScrollActivity): void {
		this.#transaction.setScrollActivity(activity);
	}
	refreshLayout(): void {
		this.#transaction.refreshLayout();
	}
	remeasure(element: HTMLElement): void {
		const measurement = this.#driver.measureElement(element);
		if (measurement) this.#transaction.measure([measurement], 'resize');
	}
	remeasureAll(): void {
		this.#transaction.measure(this.#driver.measureAll(), 'resize');
	}
	suspend(): void {
		this.#transaction.suspend();
	}
	resume(target: VirtualResumeTarget): VirtualResumeResult {
		return this.#transaction.resume(target);
	}

	scrollToIndex(
		index: number,
		options?: { readonly align?: 'start' | 'center' | 'end' },
	): VirtualIndexScrollResult {
		return this.#transaction.scrollToIndex(index, options?.align);
	}
	scrollToKey(
		key: string,
		options?: { readonly align?: 'start' | 'center' | 'end' },
	): VirtualKeyScrollResult {
		return this.#transaction.scrollToKey(key, options?.align);
	}
	scrollToAnchor(key: string, viewportOffset: number): VirtualKeyScrollResult {
		return this.#transaction.scrollToAnchor(key, viewportOffset);
	}
	scrollToStart(): VirtualScrollResult {
		return this.#transaction.scrollToStart();
	}
	scrollToEnd(): VirtualScrollResult {
		return this.#transaction.scrollToEnd();
	}
	scrollBy(delta: number): VirtualScrollResult {
		return this.#transaction.scrollBy(delta);
	}
	cancelOwnedScroll(): void {
		this.#transaction.cancelOwnedScroll();
	}
	destroy(): void {
		this.#transaction.destroy();
	}
}
