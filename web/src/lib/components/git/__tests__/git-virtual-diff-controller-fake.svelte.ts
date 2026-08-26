import type { Attachment } from 'svelte/attachments';
import type { VirtualListControllerOptions } from '$lib/virt/virtual-list-controller.svelte.js';
import type {
	VirtualIndexScrollResult,
	VirtualItem,
	VirtualItemsMutation,
	VirtualListSnapshot,
	VirtualMutationResult,
	VirtualRange,
	VirtualScrollResult,
	VirtualViewportPosition,
} from '$lib/virt/virtual-list-types.js';

export const virtualDiffControllerCalls = {
	options: [] as VirtualListControllerOptions[],
	mutations: [] as VirtualItemsMutation[],
	scrollToIndexes: [] as number[],
	scrollToStarts: 0,
};

const instances = new Set<FakeVirtualListController>();

export function resetVirtualDiffControllerFake(): void {
	instances.clear();
	virtualDiffControllerCalls.options.length = 0;
	virtualDiffControllerCalls.mutations.length = 0;
	virtualDiffControllerCalls.scrollToIndexes.length = 0;
	virtualDiffControllerCalls.scrollToStarts = 0;
}

export function publishVirtualDiffRange(startIndex: number, endIndex = startIndex): void {
	for (const instance of instances) instance.publishRange({ startIndex, endIndex });
}

class PositionView {
	readonly count: number;
	readonly #items: readonly VirtualItem[];

	constructor(keys: readonly string[], sizes: readonly number[]) {
		let start = 0;
		this.#items = keys.map((key, index) => {
			const size = sizes[index] ?? 0;
			const item = { key, index, start, size, end: start + size };
			start = item.end;
			return item;
		});
		this.count = this.#items.length;
	}

	itemAt(index: number): VirtualItem | undefined {
		return this.#items[index];
	}

	itemAtOffset(offset: number): VirtualItem | undefined {
		return this.#items.find((item) => item.end > offset) ?? this.#items.at(-1);
	}

	get totalSize(): number {
		return this.#items.at(-1)?.end ?? 0;
	}
}

export class FakeVirtualListController {
	readonly viewport: Attachment<HTMLElement>;
	readonly sizer: Attachment<HTMLElement> = () => undefined;

	#snapshot = $state.raw<VirtualListSnapshot>({
		revision: 0,
		visibleRange: null,
		overscanRange: null,
		sizerSize: 0,
		positions: new PositionView([], []),
	});
	#viewport: HTMLElement | null = null;
	#range: VirtualRange | null = null;
	#keys: readonly string[] = [];
	#sizes: readonly number[] = [];
	#attachments = new Map<string, Attachment<HTMLElement>>();

	constructor(options: VirtualListControllerOptions) {
		virtualDiffControllerCalls.options.push(options);
		instances.add(this);
		this.viewport = (element) => {
			this.#viewport = element;
			return () => {
				if (this.#viewport === element) this.#viewport = null;
			};
		};
	}

	get snapshot(): VirtualListSnapshot {
		return this.#snapshot;
	}

	get viewportPosition(): VirtualViewportPosition | null {
		if (!this.#viewport) return null;
		return {
			paintedOffset: this.#viewport.scrollTop,
			logicalOffset: this.#viewport.scrollTop,
			distanceFromStart: Math.max(0, this.#viewport.scrollTop),
			leadingContentReachable: true,
		};
	}

	item(key: string): Attachment<HTMLElement> {
		let attachment = this.#attachments.get(key);
		if (!attachment) {
			attachment = () => undefined;
			this.#attachments.set(key, attachment);
		}
		return attachment;
	}

	apply(mutation: VirtualItemsMutation): VirtualMutationResult {
		virtualDiffControllerCalls.mutations.push(mutation);
		this.#keys = mutation.keys;
		this.#sizes = mutation.estimates;
		if (!this.#range && this.#keys.length > 0) {
			this.#range = { startIndex: 0, endIndex: Math.min(2, this.#keys.length - 1) };
		}
		this.#publish();
		return { kind: 'applied' };
	}

	refreshLayout(): void {}

	scrollToIndex(index: number): VirtualIndexScrollResult {
		virtualDiffControllerCalls.scrollToIndexes.push(index);
		const item = this.#snapshot.positions.itemAt(index);
		if (!item) return { kind: 'missing-index' };
		if (!this.#viewport) return { kind: 'not-ready' };
		this.#viewport.scrollTop = item.start;
		return { kind: 'scheduled' };
	}

	scrollToStart(): VirtualScrollResult {
		virtualDiffControllerCalls.scrollToStarts += 1;
		if (!this.#viewport) return { kind: 'not-ready' };
		this.#viewport.scrollTop = 0;
		return { kind: 'scheduled' };
	}

	scrollBy(delta: number): VirtualScrollResult {
		if (!this.#viewport) return { kind: 'not-ready' };
		this.#viewport.scrollTop += delta;
		return { kind: 'scheduled' };
	}

	cancelOwnedScroll(): void {}

	destroy(): void {
		instances.delete(this);
		this.#viewport = null;
		this.#attachments.clear();
	}

	publishRange(range: VirtualRange): void {
		this.#range = range;
		this.#publish();
	}

	#publish(): void {
		const positions = new PositionView(this.#keys, this.#sizes);
		const maximum = this.#keys.length - 1;
		const range =
			this.#range && maximum >= 0
				? {
						startIndex: Math.min(maximum, this.#range.startIndex),
						endIndex: Math.min(maximum, this.#range.endIndex),
					}
				: null;
		this.#snapshot = {
			revision: this.#snapshot.revision + 1,
			visibleRange: range,
			overscanRange: range,
			sizerSize: positions.totalSize,
			positions,
		};
	}
}
