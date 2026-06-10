import type { ChatOrderList, ReorderQuickTarget } from '$lib/api/chats.js';
import {
	arraysEqual,
	movedId,
	previewReorder,
	resolveFilteredRelativeMove,
	sameMembers,
	type DragEndLike,
} from './drag-reorder';

export type SidebarChatOrderMap = Record<ChatOrderList, string[]>;

export type SidebarChatReorderRequest =
	| {
			kind: 'window';
			list: ChatOrderList;
			oldOrder: string[];
			newOrder: string[];
		}
	| {
			kind: 'relative';
			list: ChatOrderList;
			chatId: string;
			target: ReorderQuickTarget;
			visibleOrder: string[];
		};

interface SidebarChatReorderDeps {
	get visibleOrders(): SidebarChatOrderMap;
	get isFiltered(): boolean;
}

const chatOrderLists: ChatOrderList[] = ['pinned', 'normal', 'archived'];

function cloneOrders(orders: Partial<SidebarChatOrderMap>): Partial<SidebarChatOrderMap> {
	return { ...orders };
}

export class SidebarChatReorderState {
	#deps: SidebarChatReorderDeps;

	activeList = $state<ChatOrderList | null>(null);
	#startOrderByList = $state<Partial<SidebarChatOrderMap>>({});
	#overrideByList = $state<Partial<SidebarChatOrderMap>>({});

	constructor(deps: SidebarChatReorderDeps) {
		this.#deps = deps;
	}

	orderFor(list: ChatOrderList): string[] {
		return this.#overrideByList[list] ?? this.#deps.visibleOrders[list];
	}

	begin(list: ChatOrderList): void {
		const order = this.#deps.visibleOrders[list];
		this.activeList = list;
		this.#startOrderByList = {
			...this.#startOrderByList,
			[list]: [...order],
		};
		this.#overrideByList = {
			...this.#overrideByList,
			[list]: [...order],
		};
	}

	preview(list: ChatOrderList, event: DragEndLike): void {
		if (this.activeList !== list) return;
		const current = this.orderFor(list);
		const next = previewReorder(event, current);
		if (!next || arraysEqual(next, current)) return;
		this.#overrideByList = {
			...this.#overrideByList,
			[list]: next,
		};
	}

	finish(list: ChatOrderList, event: DragEndLike): SidebarChatReorderRequest | null {
		const oldOrder = this.#startOrderByList[list] ?? this.#deps.visibleOrders[list];
		const newOrder = this.#overrideByList[list] ?? previewReorder(event, oldOrder) ?? oldOrder;
		this.activeList = null;

		const nextStarts = cloneOrders(this.#startOrderByList);
		delete nextStarts[list];
		this.#startOrderByList = nextStarts;

		if (event.canceled || arraysEqual(oldOrder, newOrder)) {
			this.clear(list);
			return null;
		}

		this.#overrideByList = {
			...this.#overrideByList,
			[list]: [...newOrder],
		};

		if (!this.#deps.isFiltered) {
			return {
				kind: 'window',
				list,
				oldOrder,
				newOrder,
			};
		}

		const chatId = movedId(oldOrder, newOrder);
		if (!chatId) {
			this.clear(list);
			return null;
		}

		const target = resolveFilteredRelativeMove(chatId, newOrder);
		if (!target) {
			this.clear(list);
			return null;
		}

		return {
			kind: 'relative',
			list,
			chatId,
			target,
			visibleOrder: newOrder,
		};
	}

	clear(list: ChatOrderList): void {
		const nextOverrides = cloneOrders(this.#overrideByList);
		const nextStarts = cloneOrders(this.#startOrderByList);
		delete nextOverrides[list];
		delete nextStarts[list];
		this.#overrideByList = nextOverrides;
		this.#startOrderByList = nextStarts;
		if (this.activeList === list) this.activeList = null;
	}

	rollbackIfCurrent(list: ChatOrderList, failedOrder: string[]): void {
		const current = this.#overrideByList[list];
		if (current && arraysEqual(current, failedOrder)) {
			this.clear(list);
		}
	}

	reconcile(): void {
		const overrides = this.#overrideByList;
		let changed = false;
		const nextOverrides = cloneOrders(overrides);
		const nextStarts = cloneOrders(this.#startOrderByList);

		for (const list of chatOrderLists) {
			const override = overrides[list];
			if (!override) continue;
			const visible = this.#deps.visibleOrders[list];
			if (
				arraysEqual(override, visible) ||
				!sameMembers(override, visible)
			) {
				delete nextOverrides[list];
				delete nextStarts[list];
				changed = true;
			}
		}

		if (changed) {
			this.#overrideByList = nextOverrides;
			this.#startOrderByList = nextStarts;
		}
	}
}
