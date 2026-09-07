// Canonical chat session store. Single source of truth for chat entities,
// selection state, and draft lifecycle. Replaces split ownership between
// AppShell's local chats array and NavigationStore's selectedChat snapshot.

import {
	deleteChat as deleteChatApi,
	applyChatTagDelta as applyChatTagDeltaApi,
	generateChatTitle,
	listChats,
	recoverChatTags as recoverChatTagsApi,
	replaceChatTags as replaceChatTagsApi,
	reorderChat as reorderChatApi,
	setLastSelectedChat,
	transitionChatTags as transitionChatTagsApi,
	toggleArchive as toggleArchiveApi,
	type ToggleArchiveResponse,
} from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import { updateSessionName } from '$lib/api/settings.js';
import type { ChatSession } from '$lib/types/session';
import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';
import * as m from '$lib/paraglide/messages.js';
import type { ChatListEntry } from '$shared/chat-list';
import type { ChatProcessingEntry, ChatProcessingPhase } from '$shared/chat-types';
import { normalizeTags } from '$shared/tags';
import type {
	ApplyChatTagDeltaRequest,
	ChatTagsMutationResponse,
	CommandTagMutationOutcome,
	RecoverChatTagsResponse,
	ReplaceChatTagsRequest,
	TransitionChatTagsRequest,
} from '$shared/chat-tag-mutations';
import type { ChatOrderBoundary, ReorderChatResponse } from '$shared/chat-order-contracts';
import {
	chatExecutionDraftStorageKey,
	removeLocalStorageItem,
} from '$lib/utils/local-persistence.js';
import {
	ChatArchiveProjectionState,
	type ChatArchiveProjectionOperation,
} from './chat-archive-projection-state.svelte.js';
import {
	ChatProjectBindingState,
	type ProjectPathChangedListener,
} from './chat-project-binding-state.js';
import {
	createChatTagMutationResult,
	isUnknownChatTagOutcome,
	sameChatTags,
} from './chat-tag-mutation-result.js';
import type {
	ChatArchiveMutation,
	ChatListLoadStatus,
	ChatProcessingTransition,
	ChatSessionsPort,
	ChatSessionsStoreDeps,
} from './chat-sessions-contract.js';
import {
	insertServerEntry,
	normalizeExecutionFields,
	reconcileActivityProjection,
	sameRecord,
	toRecord,
} from './chat-session-records.js';

interface ArchiveMutationSettlement {
	chatId: string;
	result: PromiseSettledResult<ToggleArchiveResponse>;
	requiredRefreshGeneration: number;
	serverEntryGenerationAtSettlement: number;
}

export class ChatSessionsStore implements ChatSessionsPort {
	#baseById = $state.raw<Record<string, ChatSessionRecord>>({});
	#baseOrder = $state.raw<string[]>([]);
	selectedChatId = $state<string | null>(null);
	lastSelectedChatId = $state<string | null>(null);
	startupByChatId = $state<Record<string, ChatStartupConfig>>({});
	isLoadingChats = $state(true);
	chatListStatus = $state<ChatListLoadStatus>('loading');
	chatListError = $state<string | null>(null);
	#pendingTagMutationChatIds = $state.raw<Set<string>>(new Set());
	#tagRecoveryRequiredChatIds = $state.raw<Set<string>>(new Set());

	#deps: ChatSessionsStoreDeps;
	#inFlightFetch: Promise<void> | null = null;
	#needsFollowUpFetch = false;
	#nextFetchGeneration = 0;
	#latestSuccessfulFetchGeneration = 0;
	#nextServerEntryGeneration = 0;
	readonly #serverEntryGenerationByChatId = new Map<string, number>();
	readonly #serverEntryFetchGenerationByChatId = new Map<string, number>();
	readonly #pendingTagMutationCountByChatId = new Map<string, number>();
	readonly #tagRecoveryGenerationByChatId = new Map<string, number>();
	readonly #tagRecoveryByChatId = new Map<string, Promise<RecoverChatTagsResponse>>();
	#selectionWriteInFlight = false;
	#selectionWritePending: string | null | undefined = undefined;
	#selectionWriteAcked: string | null = null;
	#processingSnapshot: Map<string, ChatProcessingPhase> | null = null;
	readonly #processingOverrides = new Map<string, ChatProcessingPhase | null>();
	readonly #archiveProjection = new ChatArchiveProjectionState();
	readonly #projectBindings = new ChatProjectBindingState();

	#byId = $derived.by(() => this.#archiveProjection.projectRecords(this.#baseById));
	#order = $derived.by(() => this.#archiveProjection.projectOrder(this.#baseOrder, this.#byId));

	#selectedChat = $derived.by(() => {
		if (!this.selectedChatId) return null;
		return this.#byId[this.selectedChatId] ?? null;
	});

	#orderedChats = $derived.by(() =>
		this.#order
			.map((id) => this.#byId[id])
			.filter((chat): chat is ChatSessionRecord => Boolean(chat)),
	);

	constructor(deps: ChatSessionsStoreDeps = {}) {
		this.#deps = deps;
	}

	get selectedChat(): ChatSessionRecord | null {
		return this.#selectedChat;
	}

	get byId(): Record<string, ChatSessionRecord> {
		return this.#byId;
	}

	set byId(records: Record<string, ChatSessionRecord>) {
		this.#baseById = records;
		this.#pruneServerEntryGenerations(records);
	}

	get order(): string[] {
		return this.#order;
	}

	set order(chatIds: string[]) {
		this.#baseOrder = chatIds;
	}

	get orderedChats(): ChatSessionRecord[] {
		return this.#orderedChats;
	}

	get pendingTagMutationChatIds(): ReadonlySet<string> {
		return this.#pendingTagMutationChatIds;
	}

	get tagRecoveryRequiredChatIds(): ReadonlySet<string> {
		return this.#tagRecoveryRequiredChatIds;
	}

	setSelectedChatId(chatId: string | null): void {
		this.selectedChatId = chatId;
	}

	async #runFetch(showLoading: boolean): Promise<void> {
		const fetchGeneration = ++this.#nextFetchGeneration;
		const initial = this.chatListStatus !== 'ready';
		if (showLoading) this.isLoadingChats = true;
		if (showLoading && initial) this.chatListStatus = 'loading';
		try {
			const fetchChats = this.#deps.listChats ?? listChats;
			const projectPathRevisions = this.#projectBindings.captureRevisions();
			const res = await fetchChats();
			this.lastSelectedChatId =
				typeof res.lastSelectedChatId === 'string' ? res.lastSelectedChatId : null;
			this.#upsertFromServer(res.sessions ?? [], projectPathRevisions, fetchGeneration);
			this.#latestSuccessfulFetchGeneration = fetchGeneration;
			this.chatListStatus = 'ready';
			this.chatListError = null;
		} catch (err) {
			const prefix = showLoading ? 'Failed to fetch chats' : 'Quiet refresh failed';
			console.error(`[ChatSessionsStore] ${prefix}:`, err);
			this.#deps.notifyError?.(m.notifications_refresh_chats_failed());
			this.chatListError = err instanceof Error ? err.message : String(err);
			if (initial) this.chatListStatus = 'error';
		} finally {
			if (showLoading) this.isLoadingChats = false;
		}
	}

	async #refresh(showLoading: boolean): Promise<void> {
		if (this.#inFlightFetch) {
			this.#needsFollowUpFetch = true;
			return this.#inFlightFetch;
		}

		this.#inFlightFetch = (async () => {
			let useLoadingState = showLoading;
			try {
				do {
					this.#needsFollowUpFetch = false;
					await this.#runFetch(useLoadingState);
					useLoadingState = false;
				} while (this.#needsFollowUpFetch);
			} finally {
				this.#inFlightFetch = null;
			}
		})();
		return this.#inFlightFetch;
	}

	/** Fetches the chat list with sidebar loading feedback. */
	async refreshChats(): Promise<void> {
		return this.#refresh(true);
	}

	/** Refreshes the chat list without changing sidebar loading state. */
	async quietRefreshChats(): Promise<void> {
		return this.#refresh(false);
	}

	isArchiveMutationPending(chatId: string): boolean {
		return this.#archiveProjection.isPending(chatId);
	}

	isChatOptimisticallyArchived(chatId: string): boolean {
		return this.#archiveProjection.isOptimisticallyArchived(chatId);
	}

	startArchivingChats(chatIds: readonly string[]): ChatArchiveMutation {
		return this.#startArchiveMutation(chatIds, true);
	}

	startUnarchivingChats(chatIds: readonly string[]): ChatArchiveMutation {
		return this.#startArchiveMutation(chatIds, false);
	}

	#startArchiveMutation(chatIds: readonly string[], targetArchived: boolean): ChatArchiveMutation {
		const operation = this.#archiveProjection.admit(this.#byId, chatIds, targetArchived);
		return {
			chatIds: operation.chatIds,
			completion: this.#executeArchiveMutation(operation),
		};
	}

	async #executeArchiveMutation(operation: ChatArchiveProjectionOperation): Promise<void> {
		if (operation.chatIds.length === 0) return;
		const toggleRemoteArchive = this.#deps.toggleArchive ?? toggleArchiveApi;
		const settlements = await Promise.all(
			operation.chatIds.map((chatId) => this.#settleArchiveMutation(chatId, toggleRemoteArchive)),
		);
		await this.#refresh(false);

		if (operation.targetArchived) {
			this.#applyAcknowledgedArchives(settlements);
		}
		this.#archiveProjection.complete(operation);

		for (const { chatId, result } of settlements) {
			if (result.status === 'rejected') throw result.reason;
			if (!result.value.success || result.value.isArchived !== operation.targetArchived) {
				throw new Error(`Archive mutation did not reach the requested state for ${chatId}`);
			}
		}
	}

	async #settleArchiveMutation(
		chatId: string,
		toggleRemoteArchive: typeof toggleArchiveApi,
	): Promise<ArchiveMutationSettlement> {
		// Lets the initiating handler navigate before archive I/O begins.
		await Promise.resolve();
		let result: PromiseSettledResult<ToggleArchiveResponse>;
		try {
			const value = await toggleRemoteArchive(chatId);
			result = { status: 'fulfilled', value };
		} catch (reason) {
			result = { status: 'rejected', reason };
		}

		return {
			chatId,
			result,
			// Only a fetch started after this mutation settles can reconcile it.
			requiredRefreshGeneration: this.#nextFetchGeneration + 1,
			serverEntryGenerationAtSettlement: this.#serverEntryGenerationByChatId.get(chatId) ?? 0,
		};
	}

	#applyAcknowledgedArchives(settlements: ArchiveMutationSettlement[]): void {
		const archivedIds: string[] = [];
		let nextById = this.#baseById;
		for (const settlement of settlements) {
			const { chatId } = settlement;
			if (!this.#shouldApplyAcknowledgedArchive(settlement)) continue;
			const chat = this.#baseById[chatId];
			if (!chat) continue;
			if (nextById === this.#baseById) nextById = { ...this.#baseById };
			nextById[chatId] = {
				...chat,
				isArchived: true,
				isPinned: false,
				orderGroup: 'archived',
			};
			archivedIds.push(chatId);
		}
		if (archivedIds.length === 0) return;

		const archivedIdSet = new Set(archivedIds);
		const nextOrder = this.#baseOrder.filter((chatId) => !archivedIdSet.has(chatId));
		const archivedIndex = nextOrder.findIndex(
			(chatId) => nextById[chatId]?.orderGroup === 'archived',
		);
		nextOrder.splice(archivedIndex < 0 ? nextOrder.length : archivedIndex, 0, ...archivedIds);
		this.#baseById = nextById;
		this.#baseOrder = nextOrder;
	}

	#shouldApplyAcknowledgedArchive(settlement: ArchiveMutationSettlement): boolean {
		if (this.#latestSuccessfulFetchGeneration >= settlement.requiredRefreshGeneration) {
			return false;
		}
		const serverEntryGeneration = this.#serverEntryGenerationByChatId.get(settlement.chatId) ?? 0;
		if (serverEntryGeneration > settlement.serverEntryGenerationAtSettlement) {
			const sourceFetchGeneration = this.#serverEntryFetchGenerationByChatId.get(settlement.chatId);
			if (
				sourceFetchGeneration === undefined
				|| sourceFetchGeneration >= settlement.requiredRefreshGeneration
			) return false;
		}

		const { result } = settlement;
		return result.status === 'fulfilled' && result.value.success && result.value.isArchived;
	}

	/** Deletes a chat server-side after callers apply any optimistic local removal. */
	async deleteRemoteChat(chatId: string): Promise<void> {
		try {
			const removeRemoteChat = this.#deps.deleteChat ?? deleteChatApi;
			await removeRemoteChat(chatId);
		} catch (err) {
			console.error('[ChatSessionsStore] Delete failed:', err);
			this.#deps.notifyError?.(m.notifications_delete_chat_failed());
			await this.quietRefreshChats();
		}
	}

	async renameChat(chatId: string, newTitle: string): Promise<boolean> {
		try {
			const renameRemoteChat = this.#deps.updateSessionName ?? updateSessionName;
			await renameRemoteChat(chatId, newTitle);
			return true;
		} catch (err) {
			console.error('[ChatSessionsStore] Rename failed:', err);
			this.#deps.notifyError?.(m.notifications_rename_chat_failed());
			return false;
		}
	}

	async moveChatToBoundary(
		chatId: string,
		boundary: ChatOrderBoundary,
	): Promise<ReorderChatResponse | null> {
		try {
			const reorderRemoteChat = this.#deps.reorderChat ?? reorderChatApi;
			const result = await reorderRemoteChat({
				chatId,
				placement: { kind: 'boundary', boundary },
			});
			await this.quietRefreshChats();
			return result;
		} catch (err) {
			console.error('[ChatSessionsStore] Reorder failed:', err);
			this.#deps.notifyError?.(m.notifications_reorder_chats_failed());
			return null;
		}
	}

	async replaceChatTags(request: ReplaceChatTagsRequest): Promise<ChatTagsMutationResponse> {
		const chat = this.#baseById[request.chatId];
		if (!chat) throw new Error('Chat not found');
		if (chat.status === 'draft') {
			if (!sameChatTags(chat.tags, request.expectedTags)) throw new Error('Chat tags changed');
			const tags = normalizeTags(request.tags);
			const result = createChatTagMutationResult(request.chatId, chat.tags, tags);
			this.patchDraftStartup(request.chatId, { tags });
			this.patchChat(request.chatId, { tags });
			return result;
		}
		return this.#runTagMutation(
			request.chatId,
			() => (this.#deps.replaceChatTags ?? replaceChatTagsApi)(request),
		);
	}

	async applyChatTagDelta(request: ApplyChatTagDeltaRequest): Promise<ChatTagsMutationResponse> {
		const chat = this.#baseById[request.chatId];
		if (!chat) throw new Error('Chat not found');
		if (chat.status === 'draft') {
			const remove = new Set(normalizeTags(request.removeTags ?? []));
			const tags = normalizeTags([
				...chat.tags.filter((tag) => !remove.has(tag)),
				...normalizeTags(request.addTags ?? []),
			]);
			const result = createChatTagMutationResult(request.chatId, chat.tags, tags);
			this.patchDraftStartup(request.chatId, { tags });
			this.patchChat(request.chatId, { tags });
			return result;
		}
		return this.#runTagMutation(
			request.chatId,
			() => (this.#deps.applyChatTagDelta ?? applyChatTagDeltaApi)(request),
		);
	}

	transitionChatTags(request: TransitionChatTagsRequest): Promise<ChatTagsMutationResponse> {
		if (this.#baseById[request.chatId]?.status === 'draft') {
			return Promise.reject(new Error('Draft chats cannot be transitioned'));
		}
		return this.#runTagMutation(
			request.chatId,
			() => (this.#deps.transitionChatTags ?? transitionChatTagsApi)(request),
		);
	}

	async recoverChatTags(chatId: string): Promise<RecoverChatTagsResponse> {
		const existing = this.#tagRecoveryByChatId.get(chatId);
		if (existing) return existing;
		const chat = this.#baseById[chatId];
		if (chat?.status === 'draft') return { success: true, chatId, tags: chat.tags };
		const recovery = this.#recoverLatestChatTags(chatId);
		this.#tagRecoveryByChatId.set(chatId, recovery);
		return recovery;
	}

	async #recoverLatestChatTags(chatId: string): Promise<RecoverChatTagsResponse> {
		try {
			while (true) {
				const recoveryGeneration = this.#tagRecoveryGenerationByChatId.get(chatId) ?? 0;
				const serverEntryGeneration = this.#serverEntryGenerationByChatId.get(chatId) ?? 0;
				const result = await (this.#deps.recoverChatTags ?? recoverChatTagsApi)(chatId);
				if ((this.#tagRecoveryGenerationByChatId.get(chatId) ?? 0) !== recoveryGeneration) {
					continue;
				}
				this.#setTagRecoveryRequired(chatId, false);
				this.#reconcileTagResponse(chatId, result.tags, serverEntryGeneration);
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
			await this.quietRefreshChats();
			return;
		}
		if (outcome.status === 'unknown') {
			this.#requireTagRecovery(chatId);
			void this.recoverChatTags(chatId).catch(() => {});
			return;
		}
		this.#deps.notifyError?.(m.notifications_update_chat_tags_failed());
	}

	reconcileAcceptedHandoffProjection(entry: ChatListEntry): void {
		const current = this.#baseById[entry.id];
		if (!current) {
			this.#mergeServerEntry(entry, false);
		} else {
		this.patchChat(entry.id, {
				agentId: entry.agentId as ChatSessionRecord['agentId'],
				agentOwnershipEpoch: entry.agentOwnershipEpoch,
				model: entry.model,
				apiProviderId: entry.apiProviderId ?? null,
				modelEndpointId: entry.modelEndpointId ?? null,
				modelProtocol: entry.modelProtocol ?? null,
				permissionMode: entry.permissionMode,
				thinkingMode: entry.thinkingMode,
				agentSettings: entry.agentSettings,
			});
			this.#serverEntryGenerationByChatId.set(entry.id, ++this.#nextServerEntryGeneration);
			this.#serverEntryFetchGenerationByChatId.delete(entry.id);
		}
		void this.quietRefreshChats();
	}

	async #runTagMutation(
		chatId: string,
		request: () => Promise<ChatTagsMutationResponse>,
	): Promise<ChatTagsMutationResponse> {
		if (this.#tagRecoveryRequiredChatIds.has(chatId)) {
			throw new ApiError(503, 'Confirming saved tags', 'CHAT_TAG_SAVE_UNKNOWN');
		}
		const generation = this.#serverEntryGenerationByChatId.get(chatId) ?? 0;
		this.#setTagPending(chatId, true);
		try {
			const result = await request();
			this.#reconcileTagResponse(chatId, result.tags, generation);
			return result;
		} catch (error) {
			if (isUnknownChatTagOutcome(error)) {
				this.#requireTagRecovery(chatId);
				void this.recoverChatTags(chatId).catch(() => {});
			}
			throw error;
		} finally {
			this.#setTagPending(chatId, false);
		}
	}

	#reconcileTagResponse(chatId: string, tags: readonly string[], generation: number): void {
		if ((this.#serverEntryGenerationByChatId.get(chatId) ?? 0) > generation) {
			void this.quietRefreshChats();
			return;
		}
		this.patchChat(chatId, { tags: [...tags] });
		this.#serverEntryGenerationByChatId.set(chatId, ++this.#nextServerEntryGeneration);
		this.#serverEntryFetchGenerationByChatId.delete(chatId);
		void this.quietRefreshChats();
	}

	#setTagPending(chatId: string, pending: boolean): void {
		const current = this.#pendingTagMutationCountByChatId.get(chatId) ?? 0;
		const count = pending ? current + 1 : Math.max(0, current - 1);
		if (count > 0) this.#pendingTagMutationCountByChatId.set(chatId, count);
		else this.#pendingTagMutationCountByChatId.delete(chatId);
		const next = new Set(this.#pendingTagMutationChatIds);
		if (count > 0) next.add(chatId);
		else next.delete(chatId);
		this.#pendingTagMutationChatIds = next;
	}

	#requireTagRecovery(chatId: string): void {
		const generation = (this.#tagRecoveryGenerationByChatId.get(chatId) ?? 0) + 1;
		this.#tagRecoveryGenerationByChatId.set(chatId, generation);
		this.#setTagRecoveryRequired(chatId, true);
	}

	#setTagRecoveryRequired(chatId: string, required: boolean): void {
		const next = new Set(this.#tagRecoveryRequiredChatIds);
		if (required) next.add(chatId);
		else next.delete(chatId);
		this.#tagRecoveryRequiredChatIds = next;
	}

	async generateChatTitleFromMessage(
		chatId: string,
		message: string,
		messageSeq?: number,
	): Promise<void> {
		try {
			const generateRemoteTitle = this.#deps.generateChatTitle ?? generateChatTitle;
			const response = await generateRemoteTitle({
				chatId,
				message,
				...(messageSeq === undefined ? {} : { messageSeq }),
			});
			this.patchChat(chatId, { title: response.title });
		} catch (err) {
			console.error('[ChatSessionsStore] Title generation failed:', err);
			this.#deps.notifyError?.(m.notifications_generate_chat_title_failed());
		}
	}

	rememberSelectedChat(chatId: string | null): void {
		const normalized = typeof chatId === 'string' ? chatId.trim() : '';
		this.#selectionWritePending = normalized || null;
		void this.#flushSelectionWrite();
	}

	async #flushSelectionWrite(): Promise<void> {
		if (this.#selectionWriteInFlight) return;
		const writeSelection = this.#deps.setLastSelectedChat ?? setLastSelectedChat;

		while (this.#selectionWritePending !== undefined) {
			const nextChatId = this.#selectionWritePending;
			this.#selectionWritePending = undefined;
			if (nextChatId === this.#selectionWriteAcked) continue;

			this.#selectionWriteInFlight = true;
			try {
				const response = await writeSelection(nextChatId);
				this.#selectionWriteAcked = response.lastSelectedChatId;
				this.lastSelectedChatId = response.lastSelectedChatId;
			} catch (err) {
				console.warn(
					'[ChatSessionsStore] Failed to remember selected chat:',
					err instanceof Error ? err.message : String(err),
				);
			} finally {
				this.#selectionWriteInFlight = false;
			}
		}
	}

	/** Returns true if the store contains a record for the given chat ID. */
	hasChat(chatId: string): boolean {
		return chatId in this.#baseById;
	}

	/** Returns true if the chat exists and is in draft status. */
	isDraft(chatId: string): boolean {
		return this.#baseById[chatId]?.status === 'draft';
	}

	/** Merges server-fetched sessions into the store. Preserves object identity
	 *  for unchanged records to avoid unnecessary re-renders. Drafts that the
	 *  server now owns get their startup config cleaned up. */
	upsertFromServer(sessions: ChatSession[]): void {
		this.#upsertFromServer(sessions);
	}

	#upsertFromServer(
		sessions: ChatSession[],
		requestProjectPathRevisions?: ReadonlyMap<string, number>,
		fetchGeneration?: number,
	): void {
		const nextById: Record<string, ChatSessionRecord> = {};
		const nextOrder: string[] = [];
		const previousServerChatIds = new Set(
			Object.values(this.#baseById)
				.filter((record) => record.status !== 'draft')
				.map((record) => record.id),
		);

		// Preserve drafts that the server doesn't know about yet.
		for (const [id, record] of Object.entries(this.#baseById)) {
			if (record.status === 'draft') {
				nextById[id] = record;
			}
		}

		const startupIdsToRemove: string[] = [];

		for (const session of sessions) {
			let next = toRecord(session);
			next.processingPhase = this.#resolveProcessing(next.id, next.processingPhase);
			next.isProcessing = next.processingPhase !== null;
			const prev = this.#baseById[next.id];
			next = this.#projectBindings.reconcileFetchedRecord(next, prev, requestProjectPathRevisions);
			reconcileActivityProjection(prev, next);
			if (prev && sameRecord(prev, next)) {
				nextById[next.id] = prev;
			} else {
				nextById[next.id] = next;
			}
			nextOrder.push(next.id);
			this.#serverEntryGenerationByChatId.set(next.id, ++this.#nextServerEntryGeneration);
			if (fetchGeneration === undefined) {
				this.#serverEntryFetchGenerationByChatId.delete(next.id);
			} else {
				this.#serverEntryFetchGenerationByChatId.set(next.id, fetchGeneration);
			}

			// Cleanup stale startup state once server has authoritative chat.
			if (this.startupByChatId[next.id]) {
				startupIdsToRemove.push(next.id);
			}
		}

		if (startupIdsToRemove.length > 0) {
			const startup = { ...this.startupByChatId };
			for (const id of startupIdsToRemove) {
				delete startup[id];
			}
			this.startupByChatId = startup;
		}

		// Prepend draft IDs that aren't in the server order.
		const serverIdSet = new Set(nextOrder);
		for (const chatId of previousServerChatIds) {
			if (serverIdSet.has(chatId)) continue;
			this.#projectBindings.publish(chatId, null);
			this.#processingOverrides.delete(chatId);
			this.#processingSnapshot?.delete(chatId);
		}
		const draftOrder: string[] = [];
		for (const id of this.#baseOrder) {
			if (nextById[id]?.status === 'draft' && !serverIdSet.has(id)) {
				draftOrder.push(id);
			}
		}

		this.#baseById = nextById;
		this.#baseOrder = [...draftOrder, ...nextOrder];
		this.#pruneServerEntryGenerations(nextById);
		if (this.selectedChatId && !nextById[this.selectedChatId]) {
			this.selectedChatId = null;
		}
	}

	createDraft(params: { id: string; projectPath: string; startup: ChatStartupConfig }): void {
		const { id, projectPath, startup } = params;
		const normalizedStartup = {
			...startup,
			...normalizeExecutionFields(startup),
		};

		const draft: ChatSessionRecord = {
			id,
			parentChat: null,
			projectPath,
			orderGroup: null,
			title: normalizedStartup.firstMessage.trim() || m.chat_sessions_new_session(),
			agentId: normalizedStartup.agentId,
			model: normalizedStartup.model,
			apiProviderId: normalizedStartup.apiProviderId ?? null,
			modelEndpointId: normalizedStartup.modelEndpointId ?? null,
			modelProtocol: normalizedStartup.modelProtocol ?? null,
			...normalizeExecutionFields(normalizedStartup),
			createdAt: null,
			lastActivityAt: null,
			lastReadAt: null,
			isPinned: false,
			isArchived: false,
			isProcessing: false,
			processingPhase: null,
			canReloadFromNativeHistory: false,
			isUnread: false,
			status: 'draft',
			agentOwnershipEpoch: null,
			tags: normalizedStartup.tags ?? [],
			firstMessage: undefined,
		};

		this.#baseById = { ...this.#baseById, [id]: draft };
		this.#baseOrder = this.#baseOrder.includes(id) ? this.#baseOrder : [id, ...this.#baseOrder];
		this.startupByChatId = { ...this.startupByChatId, [id]: normalizedStartup };
		this.selectedChatId = id;
	}

	/** Updates startup configuration for an existing draft chat. */
	patchDraftStartup(chatId: string, patch: Partial<ChatStartupConfig>): void {
		const chat = this.#baseById[chatId];
		if (!chat || chat.status !== 'draft') return;
		const startup = this.startupByChatId[chatId];
		if (!startup) return;
		const nextStartup = {
			...startup,
			...patch,
			...normalizeExecutionFields({ ...startup, ...patch }),
		};
		this.startupByChatId = {
			...this.startupByChatId,
			[chatId]: nextStartup,
		};
	}

	applyStartEntry(entry: ChatListEntry): void {
		this.#mergeServerEntry(entry, true);
	}

	upsertServerChat(entry: ChatListEntry): void {
		this.#mergeServerEntry(entry, false);
	}

	#mergeServerEntry(entry: ChatListEntry, clearStartup: boolean): void {
		const next = toRecord(entry);
		const previous = this.#baseById[entry.id];
		this.#projectBindings.publishIfChanged(entry.id, previous?.projectPath, next.projectPath);
		reconcileActivityProjection(previous, next);
		next.processingPhase = this.#resolveProcessing(entry.id, next.processingPhase);
		next.isProcessing = next.processingPhase !== null;
		const nextById = { ...this.#baseById, [entry.id]: next };
		const nextOrder = insertServerEntry(
			this.#baseOrder,
			nextById,
			entry.id,
			entry.orderGroup,
			previous,
		);
		this.#baseById = nextById;
		this.#baseOrder = nextOrder;
		this.#serverEntryGenerationByChatId.set(entry.id, ++this.#nextServerEntryGeneration);
		this.#serverEntryFetchGenerationByChatId.delete(entry.id);
		if ((clearStartup || previous?.status === 'draft') && this.startupByChatId[entry.id]) {
			const startup = { ...this.startupByChatId };
			delete startup[entry.id];
			this.startupByChatId = startup;
		}
	}

	removeChat(chatId: string): void {
		this.#processingOverrides.delete(chatId);
		this.#processingSnapshot?.delete(chatId);
		this.#serverEntryFetchGenerationByChatId.delete(chatId);
		this.#pendingTagMutationCountByChatId.delete(chatId);
		this.#setTagPending(chatId, false);
		this.#tagRecoveryGenerationByChatId.delete(chatId);
		this.#setTagRecoveryRequired(chatId, false);
		removeLocalStorageItem(chatExecutionDraftStorageKey(chatId));
		if (!this.#baseById[chatId]) return;
		this.#projectBindings.publish(chatId, null);

		const nextById = { ...this.#baseById };
		delete nextById[chatId];

		const nextStartup = { ...this.startupByChatId };
		delete nextStartup[chatId];

		this.#baseById = nextById;
		this.startupByChatId = nextStartup;
		this.#baseOrder = this.#baseOrder.filter((id) => id !== chatId);
		this.#serverEntryGenerationByChatId.delete(chatId);

		if (this.selectedChatId === chatId) {
			this.selectedChatId = null;
		}
	}

	#pruneServerEntryGenerations(records: Readonly<Record<string, ChatSessionRecord>>): void {
		for (const chatId of this.#serverEntryGenerationByChatId.keys()) {
			if (records[chatId]) continue;
			this.#serverEntryGenerationByChatId.delete(chatId);
			this.#serverEntryFetchGenerationByChatId.delete(chatId);
		}
	}

	/** Patches preview text for a chat in the sidebar. */
	patchPreview(chatId: string, content: string, timestamp?: string): void {
		const chat = this.#baseById[chatId];
		if (!chat) return;
		if (timestamp && chat.lastActivityAt && timestamp < chat.lastActivityAt) return;
		const lastActivityAt = timestamp ?? chat.lastActivityAt;
		const isUnread = timestamp
			? Boolean(lastActivityAt && (!chat.lastReadAt || lastActivityAt > chat.lastReadAt))
			: chat.isUnread;
		if (
			(chat.lastMessage || '') === content &&
			chat.lastActivityAt === lastActivityAt &&
			chat.isUnread === isUnread
		)
			return;
		this.#baseById = {
			...this.#baseById,
			[chatId]: { ...chat, lastMessage: content, lastActivityAt, isUnread },
		};
	}

	/** Advances live activity without changing the user/assistant preview text. */
	patchActivity(chatId: string, timestamp: string): void {
		const chat = this.#baseById[chatId];
		if (!chat || (chat.lastActivityAt && timestamp < chat.lastActivityAt)) return;
		const isUnread = Boolean(!chat.lastReadAt || timestamp > chat.lastReadAt);
		if (chat.lastActivityAt === timestamp && chat.isUnread === isUnread) return;
		this.#baseById = {
			...this.#baseById,
			[chatId]: { ...chat, lastActivityAt: timestamp, isUnread },
		};
	}

	/** Updates a chat record field, such as title after rename. */
	patchChat(chatId: string, patch: Partial<ChatSessionRecord>): void {
		const chat = this.#baseById[chatId];
		if (!chat) return;
		if (typeof patch.projectPath === 'string' && patch.projectPath !== chat.projectPath) {
			this.#projectBindings.publish(chatId, patch.projectPath);
		}
		const nextChat = {
			...chat,
			...patch,
			...normalizeExecutionFields({ ...chat, ...patch }),
		};
		this.#baseById = {
			...this.#baseById,
			[chatId]: nextChat,
		};
	}

	projectPathRevision(chatId: string): number {
		return this.#projectBindings.revision(chatId);
	}

	onProjectPathChanged(listener: ProjectPathChangedListener): () => void {
		return this.#projectBindings.subscribe(listener);
	}

	/** Applies a server-confirmed lastReadAt and recomputes isUnread locally.
	 *  Avoids the race where the server computes isUnread from a lastActivity
	 *  that advances during streaming, overwriting the client's optimistic false. */
	patchLastReadAt(chatId: string, lastReadAt: string): void {
		const chat = this.#baseById[chatId];
		if (!chat) return;
		const reconciledLastReadAt =
			chat.lastReadAt && chat.lastReadAt > lastReadAt ? chat.lastReadAt : lastReadAt;
		const isUnread = Boolean(chat.lastActivityAt && chat.lastActivityAt > reconciledLastReadAt);
		if (chat.lastReadAt === reconciledLastReadAt && chat.isUnread === isUnread) return;
		this.#baseById = {
			...this.#baseById,
			[chatId]: { ...chat, lastReadAt: reconciledLastReadAt, isUnread },
		};
	}

	/** Returns WebSocket-authoritative processing state before or after list hydration. */
	isChatProcessing(chatId: string): boolean {
		return this.processingPhase(chatId) !== null;
	}

	processingPhase(chatId: string): ChatProcessingPhase | null {
		return this.#resolveProcessing(chatId, this.#baseById[chatId]?.processingPhase ?? null);
	}

	/** Applies a WebSocket-authoritative processing event for one chat. */
	applyProcessingEvent(
		chatId: string,
		phase: ChatProcessingPhase | null,
	): ChatProcessingTransition {
		const previousPhase = this.processingPhase(chatId);
		this.#processingOverrides.set(chatId, phase);
		const chat = this.#baseById[chatId];
		if (!chat) return { chatId, previousPhase, phase };

		if (chat.processingPhase !== phase || chat.isProcessing !== (phase !== null)) {
			this.#baseById = {
				...this.#baseById,
				[chatId]: { ...chat, isProcessing: phase !== null, processingPhase: phase },
			};
		}
		return { chatId, previousPhase, phase };
	}

	/** Replaces processing state from a correlated snapshot. Later WebSocket
	 *  events override this baseline; REST list responses never do. */
	reconcileProcessing(entries: readonly ChatProcessingEntry[]): ChatProcessingTransition[] {
		const snapshot = new Map(entries.map((entry) => [entry.chatId, entry.phase]));
		const chatIds = new Set([
			...Object.keys(this.#baseById),
			...(this.#processingSnapshot?.keys() ?? []),
			...this.#processingOverrides.keys(),
			...snapshot.keys(),
		]);
		const transitions = [...chatIds].map((chatId) => ({
			chatId,
			previousPhase: this.processingPhase(chatId),
			phase: snapshot.get(chatId) ?? null,
		}));
		this.#processingSnapshot = snapshot;
		this.#processingOverrides.clear();

		let changed = false;
		const nextById = { ...this.#baseById };

		for (const [id, record] of Object.entries(nextById)) {
			const phase = snapshot.get(id) ?? null;
			if (record.processingPhase !== phase || record.isProcessing !== (phase !== null)) {
				nextById[id] = { ...record, isProcessing: phase !== null, processingPhase: phase };
				changed = true;
			}
		}

		if (changed) {
			this.#baseById = nextById;
		}
		return transitions.filter((transition) => transition.previousPhase !== transition.phase);
	}

	#resolveProcessing(
		chatId: string,
		restValue: ChatProcessingPhase | null,
	): ChatProcessingPhase | null {
		const override = this.#processingOverrides.get(chatId);
		if (override !== undefined || this.#processingOverrides.has(chatId)) return override ?? null;
		if (this.#processingSnapshot) return this.#processingSnapshot.get(chatId) ?? null;
		return restValue;
	}
}

export function createChatSessionsStore(deps: ChatSessionsStoreDeps = {}): ChatSessionsStore {
	return new ChatSessionsStore(deps);
}
