import type { Attachment } from 'svelte/attachments';
import type { SidebarChatItemLayout } from '$lib/stores/local-settings.svelte';
import { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
import {
	virtualItems as selectVirtualItems,
	type VirtualItem,
	type VirtualListSnapshot,
	type VirtualMutationAnchor,
} from '$lib/virt/virtual-list-types.js';
import {
	DEFAULT_CHAT_ROW_OVERSCAN,
	estimateSidebarVirtualRowSize,
	PROJECT_HEADER_ROW_HEIGHT,
	type SidebarVirtualRow,
} from './sidebar-virtual-chat-list.js';

interface SidebarVirtualGeometryUpdate {
	readonly rows: readonly SidebarVirtualRow[];
	readonly chatItemLayout: SidebarChatItemLayout;
	readonly rowHeight: number | undefined;
	readonly overscan: number;
}

interface SidebarNormalizedAnchor {
	readonly key: string;
	readonly offset: number;
	readonly size: number;
}

export class SidebarVirtualChatListController {
	readonly viewport: Attachment<HTMLElement>;
	readonly sizer: Attachment<HTMLElement>;

	#virt: VirtualListController;
	#overscan = DEFAULT_CHAT_ROW_OVERSCAN;
	#lastEstimatedLayout: SidebarChatItemLayout | undefined;

	constructor() {
		const getOverscan = () => this.#overscan;
		this.#virt = new VirtualListController({
			initialViewportSize: 640,
			get overscan() {
				return getOverscan();
			},
			get measurementAnchor() {
				return 'geometric' as const;
			},
		});
		this.viewport = this.#virt.viewport;
		this.sizer = this.#virt.sizer;
	}

	get snapshot(): VirtualListSnapshot {
		return this.#virt.snapshot;
	}

	update(input: SidebarVirtualGeometryUpdate): void {
		const layoutChanged =
			this.#lastEstimatedLayout !== undefined && this.#lastEstimatedLayout !== input.chatItemLayout;
		this.#lastEstimatedLayout = input.chatItemLayout;
		this.#overscan = input.overscan;
		const normalizedAnchor =
			layoutChanged && input.rowHeight === undefined ? this.#normalizedAnchor() : null;
		const result = this.#virt.apply({
			kind: 'update',
			keys: input.rows.map((row) => row.key),
			estimates: input.rows.map((row) => this.#estimateRow(row, input)),
			anchor: normalizedAnchor ? { kind: 'none' } : this.#currentAnchor(),
		});
		if (result.kind === 'rejected') {
			console.error(`Sidebar virtualization rejected source geometry: ${result.reason}`);
			return;
		}
		if (!normalizedAnchor) return;
		const row = input.rows.find((candidate) => candidate.key === normalizedAnchor.key);
		if (!row) return;
		const nextSize = this.#estimateRow(row, input);
		const normalizedOffset = Math.min(
			Math.round((normalizedAnchor.offset / normalizedAnchor.size) * nextSize),
			nextSize,
		);
		this.#virt.scrollToAnchor(normalizedAnchor.key, -normalizedOffset);
	}

	items(snapshot: VirtualListSnapshot, rows: readonly SidebarVirtualRow[]): readonly VirtualItem[] {
		const range = snapshot.overscanRange;
		const indexes = range
			? Array.from(
					{ length: range.endIndex - range.startIndex + 1 },
					(_, offset) => range.startIndex + offset,
				)
			: [];
		const visibleItems = selectVirtualItems(snapshot, indexes);
		if (visibleItems.length > 0 || rows.length === 0) return visibleItems;
		const fallbackCount = Math.min(rows.length, Math.max(24, this.#overscan * 2 + 8));
		return selectVirtualItems(
			snapshot,
			Array.from({ length: fallbackCount }, (_, index) => index),
		);
	}

	scrollBy(delta: number): void {
		this.#virt.scrollBy(delta);
	}

	scrollToIndex(index: number): void {
		this.#virt.scrollToIndex(index, { align: 'center' });
	}

	destroy(): void {
		this.#virt.destroy();
	}

	#estimateRow(row: SidebarVirtualRow, input: SidebarVirtualGeometryUpdate): number {
		if (row.type === 'project-header') return PROJECT_HEADER_ROW_HEIGHT;
		if (input.rowHeight !== undefined) return input.rowHeight;
		return estimateSidebarVirtualRowSize(row, input.chatItemLayout);
	}

	#currentAnchor(): VirtualMutationAnchor {
		const position = this.#virt.viewportPosition;
		const item = position
			? this.#virt.snapshot.positions.itemAtOffset(position.paintedOffset)
			: undefined;
		return item ? { kind: 'item', key: item.key } : { kind: 'none' };
	}

	#normalizedAnchor(): SidebarNormalizedAnchor | null {
		const position = this.#virt.viewportPosition;
		const item = position
			? this.#virt.snapshot.positions.itemAtOffset(position.paintedOffset)
			: undefined;
		if (!item) return null;
		return {
			key: item.key,
			offset: position!.paintedOffset - item.start,
			size: item.size,
		};
	}
}
