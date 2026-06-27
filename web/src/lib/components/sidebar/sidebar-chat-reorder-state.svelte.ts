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
	scope?: SidebarChatReorderScope;
}

export interface SidebarChatReorderScope {
	ids: string[];
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
	#activeScopeByList = $state<Partial<Record<ChatOrderList, string[]>>>({});
	#nextSequence = 0;

	constructor(deps: SidebarChatReorderDeps) {
		this.#deps = deps;
	}

	orderFor(list: ChatOrderList): string[] {
		return this.#overrideByList[list] ?? this.#deps.visibleOrders[list];
	}

	begin(list: ChatOrderList, chatId: string, scope?: SidebarChatReorderScope): void {
		const order = this.orderFor(list);
		const nextScopes = { ...this.#activeScopeByList };
		if (scope?.ids) nextScopes[list] = [...scope.ids];
		else delete nextScopes[list];
		this.activeList = list;
		this.activeChatId = chatId;
		this.#activeScopeByList = nextScopes;
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
		if (!next) {
			if (baseOrder.includes(input.sourceChatId) && baseOrder.includes(input.targetChatId)) {
				this.setOverrideIfChanged(input.list, current, [...baseOrder]);
			}
			return;
		}
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
		const newOrder = this.moveWithinScope({
			order: oldOrder,
			chatId: input.chatId,
			boundary: input.boundary,
			scopeIds: input.scope?.ids,
		});
		if (!newOrder || arraysEqual(oldOrder, newOrder)) return null;
		return this.persistOptimisticMove(input.list, input.chatId, newOrder, input.scope?.ids);
	}

	clear(list: ChatOrderList): void {
		const nextOverrides = cloneOrders(this.#overrideByList);
		const nextStarts = cloneOrders(this.#startOrderByList);
		const nextPending = { ...this.#pendingSequenceByList };
		const nextScopes = { ...this.#activeScopeByList };
		delete nextOverrides[list];
		delete nextStarts[list];
		delete nextPending[list];
		delete nextScopes[list];
		this.#overrideByList = nextOverrides;
		this.#startOrderByList = nextStarts;
		this.#pendingSequenceByList = nextPending;
		this.#activeScopeByList = nextScopes;
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
		const nextScopes = { ...this.#activeScopeByList };

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
				delete nextScopes[list];
				changed = true;
			}
		}

		if (changed) {
			this.#overrideByList = nextOverrides;
			this.#startOrderByList = nextStarts;
			this.#pendingSequenceByList = nextPending;
			this.#activeScopeByList = nextScopes;
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

	private moveWithinScope(input: {
		order: string[];
		chatId: string;
		boundary: BoundaryMove;
		scopeIds?: string[];
	}): string[] | null {
		if (!input.scopeIds) {
			return moveOrderToBoundary({
				order: input.order,
				chatId: input.chatId,
				boundary: input.boundary,
			});
		}

		const allowed = new Set(input.scopeIds);
		const scopedOrder = input.order.filter((id) => allowed.has(id));
		const movedScopedOrder = moveOrderToBoundary({
			order: scopedOrder,
			chatId: input.chatId,
			boundary: input.boundary,
		});
		if (!movedScopedOrder) return null;

		let scopedIndex = 0;
		return input.order.map((id) => {
			if (!allowed.has(id)) return id;
			const scopedId = movedScopedOrder[scopedIndex];
			scopedIndex += 1;
			return scopedId;
		});
	}

	private scopedOrderForTarget(
		list: ChatOrderList,
		fullOrder: string[],
		scopeIds = this.#activeScopeByList[list],
	): string[] {
		if (!scopeIds) return fullOrder;
		const allowed = new Set(scopeIds);
		return fullOrder.filter((id) => allowed.has(id));
	}

	private clearActiveScope(list: ChatOrderList): void {
		if (!this.#activeScopeByList[list]) return;
		const nextScopes = { ...this.#activeScopeByList };
		delete nextScopes[list];
		this.#activeScopeByList = nextScopes;
	}

	private persistOptimisticMove(
		list: ChatOrderList,
		chatId: string,
		newOrder: string[],
		scopeIds?: string[],
	): SidebarChatReorderRequest | null {
		this.#overrideByList = {
			...this.#overrideByList,
			[list]: [...newOrder],
		};

		const targetOrder = this.scopedOrderForTarget(list, newOrder, scopeIds);
		const target = resolveFilteredRelativeMove(chatId, targetOrder);
		if (!target) {
			this.clear(list);
			return null;
		}
		this.clearActiveScope(list);

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
