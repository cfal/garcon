import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatTagReconciliationKind } from './chat-sessions-contract.js';
import { sameChatTags } from './chat-tag-mutation-result.js';

export type ChatTagRefreshKind = Exclude<ChatTagReconciliationKind, 'durability' | null>;

export interface ChatTagSnapshotVersion {
	serverEntryGeneration: number;
	tagSettlementGeneration: number;
}

export class ChatTagReconciliationState {
	#pendingChatIds = $state.raw<Set<string>>(new Set());
	#recoveryRequiredChatIds = $state.raw<Set<string>>(new Set());
	#refreshKindByChatId = $state.raw<Map<string, ChatTagRefreshKind>>(new Map());
	readonly #pendingCountByChatId = new Map<string, number>();
	readonly #recoveryGenerationByChatId = new Map<string, number>();
	readonly #refreshFetchGenerationByChatId = new Map<string, number>();
	readonly #minimumFetchGenerationByChatId = new Map<string, number>();
	readonly #settlementGenerationByChatId = new Map<string, number>();

	get pendingChatIds(): ReadonlySet<string> {
		return this.#pendingChatIds;
	}

	get recoveryRequiredChatIds(): ReadonlySet<string> {
		return this.#recoveryRequiredChatIds;
	}

	kind(chatId: string): ChatTagReconciliationKind {
		if (this.#recoveryRequiredChatIds.has(chatId)) return 'durability';
		return this.#refreshKindByChatId.get(chatId) ?? null;
	}

	hasRefreshRequirement(chatId: string): boolean {
		return this.#refreshKindByChatId.has(chatId);
	}

	beginMutation(chatId: string): void {
		const current = this.#pendingCountByChatId.get(chatId) ?? 0;
		this.#pendingCountByChatId.set(chatId, current + 1);
		if (current > 0) return;

		const next = new Set(this.#pendingChatIds);
		next.add(chatId);
		this.#pendingChatIds = next;
	}

	endMutation(chatId: string): void {
		const current = this.#pendingCountByChatId.get(chatId) ?? 0;
		if (current > 1) {
			this.#pendingCountByChatId.set(chatId, current - 1);
			return;
		}
		this.#pendingCountByChatId.delete(chatId);
		if (!this.#pendingChatIds.has(chatId)) return;

		const next = new Set(this.#pendingChatIds);
		next.delete(chatId);
		this.#pendingChatIds = next;
	}

	requireRecovery(chatId: string): void {
		const generation = this.recoveryGeneration(chatId) + 1;
		this.#recoveryGenerationByChatId.set(chatId, generation);
		if (this.#recoveryRequiredChatIds.has(chatId)) return;

		const next = new Set(this.#recoveryRequiredChatIds);
		next.add(chatId);
		this.#recoveryRequiredChatIds = next;
	}

	recoveryGeneration(chatId: string): number {
		return this.#recoveryGenerationByChatId.get(chatId) ?? 0;
	}

	clearRecovery(chatId: string): void {
		if (!this.#recoveryRequiredChatIds.has(chatId)) return;
		const next = new Set(this.#recoveryRequiredChatIds);
		next.delete(chatId);
		this.#recoveryRequiredChatIds = next;
	}

	requireRefresh(
		chatId: string,
		kind: ChatTagRefreshKind,
		nextFetchGeneration: number,
	): void {
		const requiredFetchGeneration = nextFetchGeneration + 1;
		const currentGeneration = this.#refreshFetchGenerationByChatId.get(chatId) ?? 0;
		this.#refreshFetchGenerationByChatId.set(
			chatId,
			Math.max(currentGeneration, requiredFetchGeneration),
		);

		const currentKind = this.#refreshKindByChatId.get(chatId);
		const nextKind = currentKind === 'committed-refresh' || kind === 'committed-refresh'
			? 'committed-refresh'
			: 'conflict-refresh';
		const next = new Map(this.#refreshKindByChatId);
		next.set(chatId, nextKind);
		this.#refreshKindByChatId = next;
	}

	clearRefresh(chatId: string): void {
		this.#refreshFetchGenerationByChatId.delete(chatId);
		if (!this.#refreshKindByChatId.has(chatId)) return;
		const next = new Map(this.#refreshKindByChatId);
		next.delete(chatId);
		this.#refreshKindByChatId = next;
	}

	settleFetch(fetchGeneration: number): void {
		for (const [chatId, minimumGeneration] of this.#minimumFetchGenerationByChatId) {
			if (fetchGeneration >= minimumGeneration) {
				this.#minimumFetchGenerationByChatId.delete(chatId);
			}
		}

		const next = new Map(this.#refreshKindByChatId);
		let changed = false;
		for (const [chatId, requiredGeneration] of this.#refreshFetchGenerationByChatId) {
			if (fetchGeneration < requiredGeneration) continue;
			this.#refreshFetchGenerationByChatId.delete(chatId);
			next.delete(chatId);
			changed = true;
		}
		if (changed) this.#refreshKindByChatId = next;
	}

	captureSnapshot(chatId: string, serverEntryGeneration: number): ChatTagSnapshotVersion {
		return {
			serverEntryGeneration,
			tagSettlementGeneration: this.#settlementGenerationByChatId.get(chatId) ?? 0,
		};
	}

	hasNewerSnapshot(
		chatId: string,
		serverEntryGeneration: number,
		version: ChatTagSnapshotVersion,
	): boolean {
		return serverEntryGeneration > version.serverEntryGeneration
			|| (this.#settlementGenerationByChatId.get(chatId) ?? 0) > version.tagSettlementGeneration;
	}

	recordSettlement(chatId: string, nextFetchGeneration: number): void {
		this.#settlementGenerationByChatId.set(
			chatId,
			(this.#settlementGenerationByChatId.get(chatId) ?? 0) + 1,
		);
		this.#minimumFetchGenerationByChatId.set(chatId, nextFetchGeneration + 1);
		this.clearRefresh(chatId);
	}

	preserveSettledTags(
		next: ChatSessionRecord,
		previous: ChatSessionRecord | undefined,
		fetchGeneration: number | undefined,
	): ChatSessionRecord {
		if (!previous || fetchGeneration === undefined) return next;
		const minimumGeneration = this.#minimumFetchGenerationByChatId.get(next.id);
		if (minimumGeneration === undefined || fetchGeneration >= minimumGeneration) return next;
		if (sameChatTags(previous.tags, next.tags)) return next;
		return { ...next, tags: [...previous.tags] };
	}

	remove(chatId: string): void {
		this.#pendingCountByChatId.delete(chatId);
		if (this.#pendingChatIds.has(chatId)) {
			const pendingChatIds = new Set(this.#pendingChatIds);
			pendingChatIds.delete(chatId);
			this.#pendingChatIds = pendingChatIds;
		}
		this.#recoveryGenerationByChatId.delete(chatId);
		this.clearRecovery(chatId);
		this.clearRefresh(chatId);
		this.#minimumFetchGenerationByChatId.delete(chatId);
		this.#settlementGenerationByChatId.delete(chatId);
	}

	pruneSettlements(records: Readonly<Record<string, ChatSessionRecord>>): void {
		for (const chatId of this.#settlementGenerationByChatId.keys()) {
			if (!records[chatId]) this.#settlementGenerationByChatId.delete(chatId);
		}
	}
}
