import type {
	ChatOrderBoundary,
	PersistedChatOrderGroup,
	RelativeChatOrderPlacement,
	ReorderChatRequest,
	ReorderChatResponse,
} from '$shared/chat-order-contracts';
import type { ChatOrderSortKey } from '$shared/chat-order-sort';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';
import {
	buildSidebarChatOrderMap,
	buildSidebarChatListProjection,
	buildSidebarRowModel,
	type SidebarRowModelInput,
} from './sidebar-row-model';
import type { SidebarChatOrderMap, SidebarVirtualChatRow } from './sidebar-virtual-chat-list';
import { normalizeSidebarGroupingFields } from './sidebar-preferences';

type ProjectionInput = Omit<SidebarRowModelInput, 'orders'>;

function presentationKey(input: ProjectionInput): string {
	return JSON.stringify([
		normalizeSidebarGroupingFields(input.groupingFields),
		input.nestDelegatedChats,
		input.nestDelegatedChats && Boolean(input.separateArchivedBranches),
		Boolean(input.groupNestedProjectPaths),
		input.inactivityDuration,
		input.sortMode,
	]);
}

export interface SidebarChatReorderRequest {
	list: PersistedChatOrderGroup;
	chatId: string;
	placement: RelativeChatOrderPlacement;
	scopeKey: string;
	presentationKey: string;
}

export type SidebarOrderErrorOutcome = 'rejected' | 'unconfirmed' | 'blocked';

interface SidebarOrderDeps {
	get input(): ProjectionInput;
	write(request: ReorderChatRequest): Promise<ReorderChatResponse>;
	refresh(): Promise<boolean>;
	sort(sortKey: ChatOrderSortKey): Promise<{ changed: boolean }>;
	onError(error: unknown, outcome: SidebarOrderErrorOutcome): void;
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
	#pending = $state<SidebarChatReorderRequest | null>(null);
	#phase = $state<'idle' | 'writing' | 'refreshing' | 'recovery' | 'recovering'>('idle');
	#drag = $state<{
		chatId: string;
		list: PersistedChatOrderGroup;
		scopeKey: string;
		presentationKey: string;
		placement: RelativeChatOrderPlacement | null;
	} | null>(null);
	#disposed = false;
	// Validates gestures against live peers without feeding the preview back into validation.
	#canonicalRows = $derived.by(
		() =>
			buildSidebarRowModel({
				...this.#deps.input,
				orders: buildSidebarChatOrderMap(this.#deps.input.allChats),
			}).rows,
	);
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
		return this.#phase !== 'idle';
	}
	get recoveryRequired(): boolean {
		return this.#phase === 'recovery' || this.recovering;
	}
	get recovering(): boolean {
		return this.#phase === 'recovering';
	}
	get orders(): SidebarChatOrderMap {
		const orders = buildSidebarChatOrderMap(this.#deps.input.allChats);
		if (this.#pending) {
			const request = this.#pending;
			orders[request.list] = applySidebarRelativeMove(
				orders[request.list],
				request.chatId,
				request.placement,
			);
		}
		if (
			this.#drag?.placement &&
			!this.dragPresentationChanged &&
			this.#liveScope(this.#drag)?.includes(this.#drag.placement.referenceChatId)
		)
			orders[this.#drag.list] = applySidebarRelativeMove(
				orders[this.#drag.list],
				this.#drag.chatId,
				this.#drag.placement,
			);
		return orders;
	}

	begin(list: PersistedChatOrderGroup, chatId: string, scope: { ids: string[] }): void {
		if (this.#disposed || this.busy || this.#drag || !scope.ids.includes(chatId)) return;
		const input = this.#deps.input;
		if (input.sortMode !== 'manual') return;
		const row = this.#canonicalChatRow(list, chatId);
		if (!row?.reorderScopeIds.includes(chatId)) return;
		this.#drag = {
			list,
			chatId,
			scopeKey: row.reorderScopeKey,
			presentationKey: presentationKey(input),
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
		if (!drag || drag.chatId !== input.sourceChatId || drag.list !== input.list) return;
		if (
			this.dragPresentationChanged ||
			drag.chatId === input.targetChatId ||
			!this.#liveScope(drag)?.includes(input.targetChatId)
		) {
			drag.placement = null;
			return;
		}
		const position = input.closestEdge === 'top' ? 'before' : 'after';
		if (
			drag.placement?.referenceChatId === input.targetChatId &&
			drag.placement.position === position
		)
			return;
		drag.placement = {
			kind: 'relative',
			referenceChatId: input.targetChatId,
			position,
		};
	}

	clearPreview(): void {
		if (this.#drag) this.#drag.placement = null;
	}

	finish(list: PersistedChatOrderGroup): SidebarChatReorderRequest | null {
		const drag = this.#drag;
		this.#drag = null;
		if (!drag?.placement || drag.list !== list) return null;
		const request = {
			list: drag.list,
			chatId: drag.chatId,
			placement: drag.placement,
			scopeKey: drag.scopeKey,
			presentationKey: drag.presentationKey,
		};
		return this.#valid(request) ? request : null;
	}

	cancel(): void {
		this.#drag = null;
	}

	moveToBoundary(input: {
		list: PersistedChatOrderGroup;
		chatId: string;
		boundary: 'start' | 'end';
	}): SidebarChatReorderRequest | null {
		if (this.busy || this.#drag) return null;
		const row = this.#canonicalChatRow(input.list, input.chatId);
		if (!row) return null;
		const ids = row.reorderScopeIds;
		const anchor = input.boundary === 'start' ? ids[0] : ids.at(-1);
		if (!anchor || anchor === input.chatId) return null;
		this.begin(input.list, input.chatId, { ids });
		this.preview({
			list: input.list,
			sourceChatId: input.chatId,
			targetChatId: anchor,
			closestEdge: input.boundary === 'start' ? 'top' : 'bottom',
		});
		return this.finish(input.list);
	}

	moveAdjacent(input: {
		list: PersistedChatOrderGroup;
		chatId: string;
		offset: -1 | 1;
	}): SidebarChatReorderRequest | null {
		if (this.busy || this.#drag) return null;
		const row = this.#canonicalChatRow(input.list, input.chatId);
		if (!row) return null;
		const ids = row.reorderScopeIds;
		const index = ids.indexOf(input.chatId);
		const target = index >= 0 ? ids[index + input.offset] : undefined;
		if (!target) return null;
		const visible = this.#visibleScopeIds(row.reorderScopeKey);
		// Crosses intervening context/cycle branches without also jumping over the eligible peer.
		const adjacent = visible[visible.indexOf(input.chatId) + input.offset] === target;
		let closestEdge: 'top' | 'bottom';
		if (input.offset === -1) {
			closestEdge = adjacent ? 'top' : 'bottom';
		} else {
			closestEdge = adjacent ? 'bottom' : 'top';
		}
		this.begin(input.list, input.chatId, { ids });
		this.preview({
			list: input.list,
			sourceChatId: input.chatId,
			targetChatId: target,
			closestEdge,
		});
		return this.finish(input.list);
	}

	#canonicalChatRow(list: PersistedChatOrderGroup, chatId: string): SidebarVirtualChatRow | null {
		const row = this.#canonicalRows.find((row) => row.type === 'chat' && row.chat.id === chatId);
		return row?.type === 'chat' && row.list === list ? row : null;
	}

	#liveScope(
		source: Pick<SidebarChatReorderRequest, 'chatId' | 'list' | 'scopeKey'>,
	): readonly string[] | null {
		const row = this.#canonicalChatRow(source.list, source.chatId);
		if (
			!row ||
			row.reorderScopeKey !== source.scopeKey ||
			!row.reorderScopeIds.includes(source.chatId)
		)
			return null;
		return row.reorderScopeIds;
	}

	#visibleScopeIds(scopeKey: string): string[] {
		return this.#canonicalRows.flatMap((row) =>
			row.type === 'chat' && row.reorderScopeKey === scopeKey ? [row.chat.id] : [],
		);
	}

	#valid(request: SidebarChatReorderRequest): boolean {
		if (request.presentationKey !== presentationKey(this.#deps.input)) return false;
		if (!this.#liveScope(request)?.includes(request.placement.referenceChatId)) return false;
		// Visible context branches affect placement even though they cannot be anchors.
		const ids = this.#visibleScopeIds(request.scopeKey);
		const source = ids.indexOf(request.chatId);
		const target = ids.indexOf(request.placement.referenceChatId);
		if (target < 0 || source === target) return false;
		return source !== target + (request.placement.position === 'before' ? -1 : 1);
	}

	submit(request: SidebarChatReorderRequest): void {
		if (this.#disposed || this.busy || this.#drag || !this.#valid(request)) return;
		this.#pending = request;
		void this.#mutate(async () => {
			await this.#deps.write({ chatId: request.chatId, placement: request.placement });
			return false;
		});
	}

	async moveChatToBoundary(
		chatId: string,
		boundary: ChatOrderBoundary,
	): Promise<ReorderChatResponse | null> {
		if (this.#disposed) return null;
		if (this.busy || this.#drag) {
			this.#deps.onError(new Error('Chat ordering is busy'), 'blocked');
			return null;
		}
		let result: ReorderChatResponse | null = null;
		await this.#mutate(async () => {
			result = await this.#deps.write({ chatId, placement: { kind: 'boundary', boundary } });
			return false;
		});
		// Acknowledged commands stay consumed even when refreshing requires recovery.
		return this.#disposed ? null : result;
	}

	async #refresh(): Promise<boolean> {
		try {
			return await this.#deps.refresh();
		} catch {
			// The session owner reports fetch errors; ordering retains explicit recovery.
			return false;
		}
	}

	async #mutate(write: () => Promise<boolean>): Promise<boolean> {
		this.#phase = 'writing';
		let changed = false;
		try {
			changed = await write();
		} catch (error) {
			if (this.#disposed) return false;
			const rejected = definitelyRejected(error);
			if (rejected) this.#pending = null;
			this.#deps.onError(error, rejected ? 'rejected' : 'unconfirmed');
		}
		if (this.#disposed) return false;
		this.#phase = 'refreshing';
		return (await this.#settle()) && changed;
	}

	async #settle(): Promise<boolean> {
		const refreshed = await this.#refresh();
		if (this.#disposed) return false;
		if (refreshed) this.#pending = null;
		this.#phase = refreshed ? 'idle' : 'recovery';
		return refreshed;
	}

	async recover(): Promise<void> {
		if (this.#disposed || this.#phase !== 'recovery') return;
		this.#phase = 'recovering';
		await this.#settle();
	}

	async sort(sortKey: ChatOrderSortKey): Promise<boolean> {
		if (this.#disposed || this.busy || this.#drag) return false;
		return this.#mutate(async () => (await this.#deps.sort(sortKey)).changed);
	}

	destroy(): void {
		this.#disposed = true;
		this.#pending = null;
		this.#phase = 'idle';
		this.#drag = null;
	}
}
