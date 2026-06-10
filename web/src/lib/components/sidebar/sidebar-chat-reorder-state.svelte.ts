import type { ChatOrderList, ReorderQuickTarget } from '$lib/api/chats.js';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import {
	arraysEqual,
	moveInOrder,
	moveToBoundary as moveOrderToBoundary,
	resolveFilteredRelativeMove,
	sameMembers,
	type BoundaryMove,
} from './drag-reorder';

export type SidebarChatOrderMap = Record<ChatOrderList, string[]>;

export interface SidebarChatPreviewMove {
	list: ChatOrderList;
	sourceChatId: string;
	targetChatId: string;
	closestEdge: Edge | null;
}

export interface SidebarChatBoundaryMove {
	list: ChatOrderList;
	chatId: string;
	boundary: BoundaryMove;
}

export interface SidebarChatReorderRequest {
	kind: 'relative';
	list: ChatOrderList;
	chatId: string;
	target: ReorderQuickTarget;
	visibleOrder: string[];
	sequence: number;
}

interface SidebarChatReorderDeps {
	get visibleOrders(): SidebarChatOrderMap;
}

const chatOrderLists: ChatOrderList[] = ['pinned', 'normal', 'archived'];

function cloneOrders(orders: Partial<SidebarChatOrderMap>): Partial<SidebarChatOrderMap> {
	return { ...orders };
}

export class SidebarChatReorderState {
	#deps: SidebarChatReorderDeps;

	activeList = $state<ChatOrderList | null>(null);
	activeChatId = $state<string | null>(null);
	#startOrderByList = $state<Partial<SidebarChatOrderMap>>({});
	#overrideByList = $state<Partial<SidebarChatOrderMap>>({});
	#pendingSequenceByList = $state<Partial<Record<ChatOrderList, number>>>({});
	#nextSequence = 0;

	constructor(deps: SidebarChatReorderDeps) {
		this.#deps = deps;
	}

	orderFor(list: ChatOrderList): string[] {
		return this.#overrideByList[list] ?? this.#deps.visibleOrders[list];
	}

	begin(list: ChatOrderList, chatId: string): void {
		const order = this.orderFor(list);
		this.activeList = list;
		this.activeChatId = chatId;
		this.#startOrderByList = {
			...this.#startOrderByList,
			[list]: [...order],
		};
		this.#overrideByList = {
			...this.#overrideByList,
			[list]: [...order],
		};
	}

	preview(input: SidebarChatPreviewMove): void {
		if (this.activeList !== input.list || this.activeChatId !== input.sourceChatId) return;
		const current = this.orderFor(input.list);
		const baseOrder = this.#startOrderByList[input.list] ?? current;
		const next = moveInOrder({
			order: baseOrder,
			sourceChatId: input.sourceChatId,
			targetChatId: input.targetChatId,
			closestEdge: input.closestEdge,
		});
		this.setOverrideIfChanged(input.list, current, next);
	}

	finish(list: ChatOrderList): SidebarChatReorderRequest | null {
		const chatId = this.activeChatId;
		const oldOrder = this.#startOrderByList[list] ?? this.#deps.visibleOrders[list];
		const newOrder = this.#overrideByList[list] ?? oldOrder;
		this.activeList = null;
		this.activeChatId = null;

		const nextStarts = cloneOrders(this.#startOrderByList);
		delete nextStarts[list];
		this.#startOrderByList = nextStarts;

		if (!chatId || arraysEqual(oldOrder, newOrder)) {
			this.clear(list);
			return null;
		}

		return this.persistOptimisticMove(list, chatId, newOrder);
	}

	cancel(list: ChatOrderList): void {
		this.clear(list);
	}

	moveToBoundary(input: SidebarChatBoundaryMove): SidebarChatReorderRequest | null {
		const oldOrder = this.orderFor(input.list);
		const newOrder = moveOrderToBoundary({
			order: oldOrder,
			chatId: input.chatId,
			boundary: input.boundary,
		});
		if (!newOrder || arraysEqual(oldOrder, newOrder)) return null;
		return this.persistOptimisticMove(input.list, input.chatId, newOrder);
	}

	clear(list: ChatOrderList): void {
		const nextOverrides = cloneOrders(this.#overrideByList);
		const nextStarts = cloneOrders(this.#startOrderByList);
		const nextPending = { ...this.#pendingSequenceByList };
		delete nextOverrides[list];
		delete nextStarts[list];
		delete nextPending[list];
		this.#overrideByList = nextOverrides;
		this.#startOrderByList = nextStarts;
		this.#pendingSequenceByList = nextPending;
		if (this.activeList === list) {
			this.activeList = null;
			this.activeChatId = null;
		}
	}

	rollbackIfCurrent(list: ChatOrderList, sequence: number, failedOrder: string[]): void {
		if (this.#pendingSequenceByList[list] !== sequence) return;
		const current = this.#overrideByList[list];
		if (current && arraysEqual(current, failedOrder)) {
			this.clear(list);
			return;
		}
		this.completeIfCurrent(list, sequence);
	}

	completeIfCurrent(list: ChatOrderList, sequence: number): void {
		if (this.#pendingSequenceByList[list] !== sequence) return;
		const nextPending = { ...this.#pendingSequenceByList };
		delete nextPending[list];
		this.#pendingSequenceByList = nextPending;
	}

	reconcile(): void {
		const overrides = this.#overrideByList;
		let changed = false;
		const nextOverrides = cloneOrders(overrides);
		const nextStarts = cloneOrders(this.#startOrderByList);
		const nextPending = { ...this.#pendingSequenceByList };

		for (const list of chatOrderLists) {
			const override = overrides[list];
			if (!override) continue;
			const isActiveDragList = this.activeList === list;
			const hasPendingWrite = this.#pendingSequenceByList[list] !== undefined;
			const visible = this.#deps.visibleOrders[list];
			if (
				(!hasPendingWrite && !isActiveDragList && arraysEqual(override, visible)) ||
				!sameMembers(override, visible)
			) {
				delete nextOverrides[list];
				delete nextStarts[list];
				delete nextPending[list];
				changed = true;
			}
		}

		if (changed) {
			this.#overrideByList = nextOverrides;
			this.#startOrderByList = nextStarts;
			this.#pendingSequenceByList = nextPending;
			if (this.activeList && !this.#startOrderByList[this.activeList]) {
				this.activeList = null;
				this.activeChatId = null;
			}
		}
	}

	private setOverrideIfChanged(
		list: ChatOrderList,
		current: string[],
		next: string[] | null,
	): void {
		if (!next || arraysEqual(next, current)) return;
		this.#overrideByList = {
			...this.#overrideByList,
			[list]: next,
		};
	}

	private persistOptimisticMove(
		list: ChatOrderList,
		chatId: string,
		newOrder: string[],
	): SidebarChatReorderRequest | null {
		this.#overrideByList = {
			...this.#overrideByList,
			[list]: [...newOrder],
		};

		const target = resolveFilteredRelativeMove(chatId, newOrder);
		if (!target) {
			this.clear(list);
			return null;
		}

		const sequence = this.#nextSequence + 1;
		this.#nextSequence = sequence;
		this.#pendingSequenceByList = {
			...this.#pendingSequenceByList,
			[list]: sequence,
		};

		return {
			kind: 'relative',
			list,
			chatId,
			target,
			visibleOrder: newOrder,
			sequence,
		};
	}
}
