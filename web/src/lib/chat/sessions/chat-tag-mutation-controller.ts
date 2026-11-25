import {
	applyChatTagDelta as applyChatTagDeltaApi,
	getChatTagConflictResponse,
	recoverChatTags as recoverChatTagsApi,
	replaceChatTags as replaceChatTagsApi,
	transitionChatTags as transitionChatTagsApi,
} from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import type { ChatSessionRecord } from './chat-session-types.js';
import * as m from '$lib/paraglide/messages.js';
import { normalizeTags } from '$shared/tags';
import type {
	ApplyChatTagDeltaRequest,
	ChatTagsMutationResponse,
	CommandTagMutationOutcome,
	RecoverChatTagsResponse,
	ReplaceChatTagsRequest,
	TransitionChatTagsRequest,
} from '$shared/chat-tag-mutations';
import {
	ChatTagMutationBlockedError,
	createChatTagMutationResult,
	isUnknownChatTagOutcome,
	sameChatTags,
} from './chat-tag-mutation-result.js';
import {
	ChatTagReconciliationState,
	type ChatTagSnapshotVersion,
} from './chat-tag-reconciliation-state.svelte.js';
import type { ChatSessionsStoreDeps, ChatTagReconciliationKind } from './chat-sessions-contract.js';

interface TagMutationOptions {
	getChat(chatId: string): ChatSessionRecord | undefined;
	patchTags(chatId: string, tags: string[]): void;
	patchDraftTags(chatId: string, tags: string[]): void;
	refreshChats(): Promise<void>;
	entryGeneration(chatId: string): number;
	fetchGeneration(): number;
	api: Pick<ChatSessionsStoreDeps, 'replaceChatTags' | 'applyChatTagDelta' |
		'transitionChatTags' | 'recoverChatTags' | 'notifyError'>;
}

export class ChatTagMutationController {
	readonly reconciliation = new ChatTagReconciliationState();
	readonly #tagRecoveryByChatId = new Map<string, Promise<RecoverChatTagsResponse>>();

	constructor(private readonly options: TagMutationOptions) {}

	get pendingTagMutationChatIds(): ReadonlySet<string> {
		return this.reconciliation.pendingChatIds;
	}

	get tagRecoveryRequiredChatIds(): ReadonlySet<string> {
		return this.reconciliation.recoveryRequiredChatIds;
	}

	tagReconciliationKind(chatId: string): ChatTagReconciliationKind {
		return this.reconciliation.kind(chatId);
	}

	async replaceChatTags(request: ReplaceChatTagsRequest): Promise<ChatTagsMutationResponse> {
		const chat = this.options.getChat(request.chatId);
		if (!chat) throw new Error('Chat not found');
		if (chat.status === 'draft') {
			if (!sameChatTags(chat.tags, request.expectedTags)) throw new Error('Chat tags changed');
			const tags = normalizeTags(request.tags);
			const result = createChatTagMutationResult(request.chatId, chat.tags, tags);
			this.options.patchDraftTags(request.chatId, tags);
			this.options.patchTags(request.chatId, tags);
			return result;
		}
		return this.#runTagMutation(
			request.chatId,
			() => (this.options.api.replaceChatTags ?? replaceChatTagsApi)(request),
		);
	}

	async applyChatTagDelta(request: ApplyChatTagDeltaRequest): Promise<ChatTagsMutationResponse> {
		const chat = this.options.getChat(request.chatId);
		if (!chat) throw new Error('Chat not found');
		if (chat.status === 'draft') {
			const remove = new Set(normalizeTags(request.removeTags ?? []));
			const tags = normalizeTags([
				...chat.tags.filter((tag) => !remove.has(tag)),
				...normalizeTags(request.addTags ?? []),
			]);
			const result = createChatTagMutationResult(request.chatId, chat.tags, tags);
			this.options.patchDraftTags(request.chatId, tags);
			this.options.patchTags(request.chatId, tags);
			return result;
		}
		return this.#runTagMutation(
			request.chatId,
			() => (this.options.api.applyChatTagDelta ?? applyChatTagDeltaApi)(request),
		);
	}

	transitionChatTags(request: TransitionChatTagsRequest): Promise<ChatTagsMutationResponse> {
		if (this.options.getChat(request.chatId)?.status === 'draft') {
			return Promise.reject(new Error('Draft chats cannot be transitioned'));
		}
		return this.#runTagMutation(
			request.chatId,
			() => (this.options.api.transitionChatTags ?? transitionChatTagsApi)(request),
		);
	}

	async recoverChatTags(chatId: string): Promise<RecoverChatTagsResponse> {
		const existing = this.#tagRecoveryByChatId.get(chatId);
		if (existing) return existing;
		const chat = this.options.getChat(chatId);
		if (chat?.status === 'draft') return { success: true, chatId, tags: chat.tags };
		const recovery = this.#recoverLatestChatTags(chatId);
		this.#tagRecoveryByChatId.set(chatId, recovery);
		return recovery;
	}

	async retryTagReconciliation(chatId: string): Promise<void> {
		if (this.reconciliation.recoveryRequiredChatIds.has(chatId)) {
			await this.recoverChatTags(chatId);
		}
		if (this.reconciliation.hasRefreshRequirement(chatId)) {
			await this.options.refreshChats();
		}
		if (this.tagReconciliationKind(chatId) !== null) {
			throw new Error('Saved tags could not be refreshed');
		}
	}

	async #recoverLatestChatTags(chatId: string): Promise<RecoverChatTagsResponse> {
		try {
			while (true) {
				const recoveryGeneration = this.reconciliation.recoveryGeneration(chatId);
				const snapshotVersion = this.#captureTagSnapshotVersion(chatId);
				const result = await (this.options.api.recoverChatTags ?? recoverChatTagsApi)(chatId);
				if (this.reconciliation.recoveryGeneration(chatId) !== recoveryGeneration) {
					continue;
				}
				this.reconciliation.clearRecovery(chatId);
				this.#reconcileTagResponse(chatId, result.tags, snapshotVersion, 'committed');
				return result;
			}
		} finally {
			this.#tagRecoveryByChatId.delete(chatId);
		}
	}

	async observeCommandTagMutation(
		chatId: string,
		outcome: CommandTagMutationOutcome,
	): Promise<void> {
		if (outcome.status === 'applied') {
			await this.options.refreshChats();
			return;
		}
		if (outcome.status === 'unknown') {
			this.reconciliation.requireRecovery(chatId);
			void this.recoverChatTags(chatId).catch(error => console.error('Failed to recover chat tags', error));
			return;
		}
		this.options.api.notifyError?.(m.notifications_update_chat_tags_failed());
	}

	async #runTagMutation(
		chatId: string,
		request: () => Promise<ChatTagsMutationResponse>,
	): Promise<ChatTagsMutationResponse> {
		const reconciliationKind = this.reconciliation.kind(chatId);
		if (reconciliationKind) throw new ChatTagMutationBlockedError(reconciliationKind);
		const snapshotVersion = this.#captureTagSnapshotVersion(chatId);
		this.reconciliation.beginMutation(chatId);
		try {
			const result = await request();
			this.#reconcileTagResponse(chatId, result.tags, snapshotVersion, 'committed');
			return result;
		} catch (error) {
			const conflict = getChatTagConflictResponse(error);
			if (conflict) {
				this.#reconcileTagResponse(chatId, conflict.currentTags, snapshotVersion, 'conflict');
			} else if (
				error instanceof ApiError &&
				error.errorCode === 'CHAT_TAG_REVISION_CONFLICT'
			) {
				this.reconciliation.requireRefresh(
					chatId,
					'conflict-refresh',
					this.options.fetchGeneration(),
				);
				void this.options.refreshChats();
			}
			if (isUnknownChatTagOutcome(error)) {
				this.reconciliation.requireRecovery(chatId);
				void this.recoverChatTags(chatId).catch(error => console.error('Failed to recover chat tags', error));
			}
			throw error;
		} finally {
			this.reconciliation.endMutation(chatId);
		}
	}

	#reconcileTagResponse(
		chatId: string,
		tags: readonly string[],
		snapshotVersion: ChatTagSnapshotVersion,
		settlement: 'committed' | 'conflict',
	): void {
		if (this.reconciliation.hasNewerSnapshot(
			chatId,
			this.options.entryGeneration(chatId),
			snapshotVersion,
		)) {
			this.reconciliation.requireRefresh(
				chatId,
				settlement === 'committed' ? 'committed-refresh' : 'conflict-refresh',
				this.options.fetchGeneration(),
			);
			void this.options.refreshChats();
			return;
		}
		this.options.patchTags(chatId, [...tags]);
		this.reconciliation.recordSettlement(chatId, this.options.fetchGeneration());
		void this.options.refreshChats();
	}

	#captureTagSnapshotVersion(chatId: string): ChatTagSnapshotVersion {
		return this.reconciliation.captureSnapshot(
			chatId,
			this.options.entryGeneration(chatId),
		);
	}
}
