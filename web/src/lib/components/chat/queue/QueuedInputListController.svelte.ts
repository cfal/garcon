import { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
import { virtualItems, type VirtualListSnapshot } from '$lib/virt/virtual-list-types.js';
import type { QueueEntry } from '$lib/types/chat.js';

export class QueuedInputListController {
	readonly virtual = new VirtualListController({
		initialViewportSize: 240,
		overscan: 4,
		measurementAnchor: 'geometric',
	});
	#chatId: string | null = null;
	#indexById = new Map<string, number>();
	#expanded = $state<Record<string, boolean>>({});
	#retained = $state<Partial<Record<'focus' | 'drag' | 'menu', string>>>({});

	update(chatId: string | null, entries: readonly QueueEntry[]): void {
		const changedChat = chatId !== this.#chatId;
		this.#chatId = chatId;
		this.#indexById = new Map(entries.map((entry, index) => [entry.id, index]));
		this.#expanded = changedChat
			? {}
			: Object.fromEntries(
					Object.entries(this.#expanded).filter(([id]) => this.#indexById.has(id)),
				);
		this.#retained = changedChat
			? {}
			: Object.fromEntries(
					Object.entries(this.#retained).filter(([, id]) => this.#indexById.has(id)),
				);
		const position = this.virtual.viewportPosition;
		const anchor = position
			? this.virtual.snapshot.positions.itemAtOffset(position.paintedOffset)
			: undefined;
		this.virtual.apply({
			kind: changedChat ? 'reset-measurements' : 'update',
			keys: entries.map((entry) => entry.id),
			estimates: entries.map(() => 44),
			anchor: !changedChat && anchor ? { kind: 'item', key: anchor.key } : { kind: 'none' },
		});
	}

	items(snapshot: VirtualListSnapshot, entries: ReadonlyMap<string, QueueEntry>) {
		const range = snapshot.overscanRange;
		const indexes = range
			? Array.from(
					{ length: range.endIndex - range.startIndex + 1 },
					(_, offset) => range.startIndex + offset,
				)
			: Array.from({ length: Math.min(snapshot.positions.count, 12) }, (_, index) => index);
		for (const id of Object.values(this.#retained)) {
			const index = this.#indexById.get(id);
			if (index !== undefined) indexes.push(index);
		}
		return virtualItems(snapshot, indexes).flatMap((virtualItem) => {
			// Keeps keyed rows mounted while the virtual list publishes new geometry.
			const entry = entries.get(virtualItem.key);
			return entry ? [{ entry, virtualItem }] : [];
		});
	}

	retain(id: string, reason: 'focus' | 'drag' | 'menu', active: boolean): void {
		if (active) this.#retained[reason] = id;
		else if (this.#retained[reason] === id) delete this.#retained[reason];
	}

	isExpanded(id: string, defaultExpanded: boolean): boolean {
		return this.#expanded[id] ?? defaultExpanded;
	}

	toggleExpanded(id: string, defaultExpanded: boolean): void {
		this.#expanded[id] = !this.isExpanded(id, defaultExpanded);
	}

	resetExpansion(): void {
		this.#expanded = {};
	}
}
