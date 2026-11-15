import type {
	PersistedChatOrderGroup,
	RelativeChatOrderPlacement,
	ReorderChatRequest,
} from '$shared/chat-order-contracts';
import type { ChatOrderSortKey } from '$shared/chat-order-sort';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';
import {
	buildSidebarChatOrderMap,
	buildSidebarChatListProjection,
	buildSidebarRowModel,
	type SidebarRowModelInput,
} from './sidebar-row-model';
import type { SidebarChatOrderMap } from './sidebar-virtual-chat-list';

type ProjectionInput = Omit<SidebarRowModelInput, 'orders'>;

function presentationKey(input: ProjectionInput): string {
	return JSON.stringify([
		input.groupingFields,
		input.nestDelegatedChats,
		input.groupNestedProjectPaths,
		input.inactivityDuration,
		input.sortMode,
	]);
}

export interface SidebarChatReorderRequest {
	list: PersistedChatOrderGroup;
	chatId: string;
	placement: RelativeChatOrderPlacement;
	scopeKey: string;
	groupingFields: ProjectionInput['groupingFields'];
	nestDelegatedChats: boolean;
	groupNestedProjectPaths: boolean;
	inactivityDuration: ProjectionInput['inactivityDuration'];
}

interface PendingMove {
	sequence: number;
	request: SidebarChatReorderRequest;
	recoveryRequired: boolean;
	rejected: boolean;
}

interface SidebarOrderDeps {
	get input(): ProjectionInput;
	write(request: ReorderChatRequest): Promise<unknown>;
	refresh(): Promise<boolean>;
	sort(sortKey: ChatOrderSortKey): Promise<{ changed: boolean }>;
	onError(error: unknown): void;
}

export function applySidebarRelativeMove(
	order: readonly string[],
	chatId: string,
	placement: RelativeChatOrderPlacement,
): string[] {
	if (
		!order.includes(chatId) ||
		!order.includes(placement.referenceChatId) ||
		chatId === placement.referenceChatId
	)
		return [...order];
	const result = order.filter((id) => id !== chatId);
	const index = result.indexOf(placement.referenceChatId) + Number(placement.position === 'after');
	result.splice(index, 0, chatId);
	return result;
}

function definitelyRejected(error: unknown): boolean {
	if (!error || typeof error !== 'object' || !('errorCode' in error)) return false;
	return ['SESSION_NOT_FOUND', 'ORDER_CROSS_GROUP', 'VALIDATION_FAILED'].includes(
		String(error.errorCode),
	);
}

export class SidebarOrderController {
	#deps: SidebarOrderDeps;
	#pending = $state<PendingMove[]>([]);
	#drag = $state<{
		chatId: string;
		list: PersistedChatOrderGroup;
		ids: string[];
		scopeKey: string;
		presentationKey: string;
		input: ProjectionInput;
		placement: RelativeChatOrderPlacement | null;
	} | null>(null);
	#nextSequence = 0;
	#draining = new Set<PersistedChatOrderGroup>();
	#disposed = false;
	sorting = $state(false);
	sortRecovery = $state(false);
	projection = $derived.by(() =>
		buildSidebarChatListProjection({ ...this.#deps.input, orders: this.orders }),
	);

	constructor(deps: SidebarOrderDeps) {
		this.#deps = deps;
	}
	get activeList(): PersistedChatOrderGroup | null {
		return this.#drag?.list ?? null;
	}
	get activeChatId(): string | null {
		return this.#drag?.chatId ?? null;
	}
	get dragPresentationChanged(): boolean {
		return this.#drag !== null && this.#drag.presentationKey !== presentationKey(this.#deps.input);
	}
	get busy(): boolean {
		return this.sorting || this.sortRecovery || this.#pending.length > 0;
	}
	get recoveryRequired(): boolean {
		return this.sortRecovery || this.#pending.some((move) => move.recoveryRequired);
	}
	get orders(): SidebarChatOrderMap {
		const orders = buildSidebarChatOrderMap(this.#deps.input.allChats);
		for (const { request, rejected } of this.#pending) {
			if (!rejected)
				orders[request.list] = applySidebarRelativeMove(
					orders[request.list],
					request.chatId,
					request.placement,
				);
		}
		if (this.#drag?.placement)
			orders[this.#drag.list] = applySidebarRelativeMove(
				orders[this.#drag.list],
				this.#drag.chatId,
				this.#drag.placement,
			);
		return orders;
	}

	begin(list: PersistedChatOrderGroup, chatId: string, scope: { ids: string[] }): void {
		if (this.#disposed || this.sorting || this.sortRecovery || !scope.ids.includes(chatId)) return;
		const input = this.#deps.input;
		const row = buildSidebarRowModel({ ...input, orders: this.orders }).rows.find(
			(row) => row.type === 'chat' && row.chat.id === chatId,
		);
		if (row?.type !== 'chat' || row.list !== list || !row.reorderScopeIds.includes(chatId)) return;
		this.#drag = {
			list,
			chatId,
			ids: [...scope.ids],
			scopeKey: row.reorderScopeKey,
			presentationKey: presentationKey(input),
			input,
			placement: null,
		};
	}

	preview(input: {
		list: PersistedChatOrderGroup;
		sourceChatId: string;
		targetChatId: string;
		closestEdge: Edge | null;
	}): void {
		const drag = this.#drag;
		if (
			!drag ||
			drag.chatId !== input.sourceChatId ||
			drag.list !== input.list ||
			!drag.ids.includes(input.targetChatId) ||
			drag.chatId === input.targetChatId
		)
			return;
		drag.placement = {
			kind: 'relative',
			referenceChatId: input.targetChatId,
			position: input.closestEdge === 'top' ? 'before' : 'after',
		};
	}

	finish(list: PersistedChatOrderGroup): SidebarChatReorderRequest | null {
		const drag = this.#drag;
		this.#drag = null;
		if (
			!drag?.placement ||
			drag.list !== list ||
			drag.presentationKey !== presentationKey(this.#deps.input)
		)
			return null;
		const currentRows = buildSidebarRowModel({ ...this.#deps.input, orders: this.orders }).rows;
		if (
			![drag.chatId, drag.placement.referenceChatId].every((id) =>
				currentRows.some(
					(row) =>
						row.type === 'chat' &&
						row.chat.id === id &&
						row.reorderScopeKey === drag.scopeKey &&
						row.reorderScopeIds.includes(id),
				),
			)
		)
			return null;
		const order = this.orders[list];
		const moved = applySidebarRelativeMove(order, drag.chatId, drag.placement);
		if (order.every((id, index) => id === moved[index])) return null;
		return this.#request(drag.list, drag.chatId, drag.placement, drag.scopeKey, drag.input);
	}

	cancel(): void {
		this.#drag = null;
	}

	moveToBoundary(input: {
		list: PersistedChatOrderGroup;
		chatId: string;
		boundary: 'start' | 'end';
		scope: { ids: string[] };
	}): SidebarChatReorderRequest | null {
		const ids = input.scope.ids;
		const anchor = input.boundary === 'start' ? ids[0] : ids.at(-1);
		if (!anchor || anchor === input.chatId) return null;
		this.begin(input.list, input.chatId, input.scope);
		this.preview({
			list: input.list,
			sourceChatId: input.chatId,
			targetChatId: anchor,
			closestEdge: input.boundary === 'start' ? 'top' : 'bottom',
		});
		return this.finish(input.list);
	}

	#request(
		list: PersistedChatOrderGroup,
		chatId: string,
		placement: RelativeChatOrderPlacement,
		scopeKey: string,
		input: ProjectionInput,
	): SidebarChatReorderRequest {
		return {
			list,
			chatId,
			placement,
			scopeKey,
			groupingFields: input.groupingFields.map((field) => ({ ...field })),
			nestDelegatedChats: input.nestDelegatedChats,
			groupNestedProjectPaths: Boolean(input.groupNestedProjectPaths),
			inactivityDuration: input.inactivityDuration,
		};
	}

	#valid(request: SidebarChatReorderRequest): boolean {
		const input = this.#deps.input;
		const rows = buildSidebarRowModel({
			...input,
			groupingFields: request.groupingFields,
			nestDelegatedChats: request.nestDelegatedChats,
			groupNestedProjectPaths: request.groupNestedProjectPaths,
			inactivityDuration: request.inactivityDuration,
			matchingChatIds: undefined,
			collapsedProjectKeys: undefined,
			orders: buildSidebarChatOrderMap(input.allChats),
		}).rows;
		return [request.chatId, request.placement.referenceChatId].every((id) =>
			rows.some(
				(row) =>
					row.type === 'chat' &&
					row.chat.id === id &&
					row.list === request.list &&
					row.reorderScopeKey === request.scopeKey &&
					row.reorderScopeIds.includes(id),
			),
		);
	}

	enqueue(request: SidebarChatReorderRequest): void {
		if (this.#disposed || this.sorting || this.sortRecovery || !this.#valid(request)) return;
		this.#pending = [
			...this.#pending,
			{ sequence: ++this.#nextSequence, request, recoveryRequired: false, rejected: false },
		];
		void this.#drain(request.list);
	}

	async #refresh(): Promise<boolean> {
		try {
			return await this.#deps.refresh();
		} catch (error) {
			if (!this.#disposed) this.#deps.onError(error);
			return false;
		}
	}

	async #drain(list: PersistedChatOrderGroup): Promise<void> {
		if (this.#draining.has(list) || this.#disposed) return;
		this.#draining.add(list);
		try {
			while (!this.#disposed) {
				const move = this.#pending.find((entry) => entry.request.list === list);
				if (!move || move.recoveryRequired) break;
				if (!this.#valid(move.request)) {
					this.#remove(move.sequence);
					continue;
				}
				try {
					await this.#deps.write({
						chatId: move.request.chatId,
						placement: move.request.placement,
					});
				} catch (error) {
					if (this.#disposed) break;
					this.#deps.onError(error);
					move.rejected = definitelyRejected(error);
				}
				if (this.#disposed) break;
				const refreshed = await this.#refresh();
				if (this.#disposed) break;
				if (!refreshed) {
					move.recoveryRequired = true;
					break;
				}
				this.#remove(move.sequence);
			}
		} finally {
			this.#draining.delete(list);
		}
	}

	#remove(sequence: number): void {
		this.#pending = this.#pending.filter((move) => move.sequence !== sequence);
	}

	async recover(): Promise<void> {
		if (this.#disposed) return;
		const recovering = this.#pending
			.filter((move) => move.recoveryRequired)
			.map((move) => move.sequence);
		if (!(await this.#refresh()) || this.#disposed) return;
		for (const sequence of recovering) this.#remove(sequence);
		this.sortRecovery = false;
		for (const list of ['pinned', 'normal', 'archived'] as const) void this.#drain(list);
	}

	async sort(sortKey: ChatOrderSortKey): Promise<boolean> {
		if (this.#disposed || this.busy || this.#drag) return false;
		this.sorting = true;
		try {
			let changed = false;
			try {
				changed = (await this.#deps.sort(sortKey)).changed;
			} catch (error) {
				if (!this.#disposed) this.#deps.onError(error);
			}
			if (this.#disposed) return false;
			const refreshed = await this.#refresh();
			if (!this.#disposed) this.sortRecovery = !refreshed;
			return !this.#disposed && changed && refreshed;
		} finally {
			this.sorting = false;
		}
	}

	destroy(): void {
		this.#disposed = true;
		this.#pending = [];
		this.#drag = null;
	}
}
