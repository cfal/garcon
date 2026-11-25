import type { Attachment } from 'svelte/attachments';
import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
import { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
import {
	currentAnchor,
	indexesInRange,
	virtualItems as selectVirtualItems,
	type VirtualIndexScrollResult,
	type VirtualItem,
	type VirtualListSnapshot,
	type VirtualMutationAnchor,
} from '$lib/virt/virtual-list-types.js';
import {
	DEFAULT_CHAT_ROW_OVERSCAN,
	estimateSidebarVirtualRowSize,
	type SidebarVirtualRow,
} from '../../sidebar/display/sidebar-virtual-chat-list.js';

interface SidebarVirtualGeometryUpdate {
	readonly rows: readonly SidebarVirtualRow[];
	readonly chatItemLayout: ChatItemLayout;
	readonly showProjectPath: boolean;
	readonly chatFontScale: number;
	readonly rowHeight: number | undefined;
	readonly overscan: number;
}

export class SidebarVirtualChatListController {
	readonly viewport: Attachment<HTMLElement>;
	readonly sizer: Attachment<HTMLElement>;

	#virt: VirtualListController;
	#overscan = DEFAULT_CHAT_ROW_OVERSCAN;
	#lastEstimatedLayout: ChatItemLayout | undefined;
	#lastShowProjectPath = false;
	#lastChatFontScale = 1;
	#source: { keys: string[]; estimates: number[] } | undefined;

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
		const sizingOptionsChanged =
			this.#lastEstimatedLayout !== undefined &&
			(this.#lastEstimatedLayout !== input.chatItemLayout ||
				this.#lastShowProjectPath !== input.showProjectPath ||
				this.#lastChatFontScale !== input.chatFontScale);
		const source = this.#source;
		// Preview and badge updates can replace every row object without moving a single item.
		if (
			!sizingOptionsChanged &&
			this.#overscan === input.overscan &&
			source?.keys.length === input.rows.length &&
			input.rows.every(
				(row, i) =>
					row.key === source.keys[i] && this.#estimateRow(row, input) === source.estimates[i],
			)
		)
			return;
		this.#lastEstimatedLayout = input.chatItemLayout;
		this.#lastShowProjectPath = input.showProjectPath;
		this.#lastChatFontScale = input.chatFontScale;
		this.#overscan = input.overscan;
		const normalizedAnchor =
			sizingOptionsChanged && input.rowHeight === undefined ? this.#anchor() : null;
		const nextSource = {
			keys: input.rows.map((row) => row.key),
			estimates: input.rows.map((row) => this.#estimateRow(row, input)),
		};
		const result = this.#virt.apply({
			kind: 'update',
			...nextSource,
			anchor: normalizedAnchor ? { kind: 'none' } : this.#currentAnchor(),
		});
		if (result.kind === 'rejected') {
			console.error(`Sidebar virtualization rejected source geometry: ${result.reason}`);
			return;
		}
		this.#source = nextSource;
		if (!normalizedAnchor) return;
		const anchorIndex = nextSource.keys.indexOf(normalizedAnchor.key);
		if (anchorIndex < 0) return;
		const nextSize = nextSource.estimates[anchorIndex];
		const normalizedOffset = Math.min(
			Math.round((normalizedAnchor.offset / normalizedAnchor.size) * nextSize),
			nextSize,
		);
		this.#virt.scrollToAnchor(normalizedAnchor.key, -normalizedOffset);
	}

	items(snapshot: VirtualListSnapshot, rows: readonly SidebarVirtualRow[]): readonly VirtualItem[] {
		const visibleItems = selectVirtualItems(snapshot, indexesInRange(snapshot.overscanRange));
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

	scrollToIndex(index: number): VirtualIndexScrollResult {
		return this.#virt.scrollToIndex(index, { align: 'center' });
	}

	destroy(): void {
		this.#source = undefined;
		this.#virt.destroy();
	}

	#estimateRow(row: SidebarVirtualRow, input: SidebarVirtualGeometryUpdate): number {
		if (row.type === 'chat' && input.rowHeight !== undefined) return input.rowHeight;
		return estimateSidebarVirtualRowSize(
			row,
			input.chatItemLayout,
			input.showProjectPath,
			input.chatFontScale,
		);
	}

	#currentAnchor(): VirtualMutationAnchor {
		const item = this.#anchor();
		return item ? { kind: 'item', key: item.key } : { kind: 'none' };
	}

	#anchor() {
		const position = this.#virt.viewportPosition;
		return position ? currentAnchor(this.#virt.snapshot.positions, position) : null;
	}
}
