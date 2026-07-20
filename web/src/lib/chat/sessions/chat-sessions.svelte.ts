// Canonical chat session store. Single source of truth for chat entities,
// selection state, and draft lifecycle. Replaces split ownership between
// AppShell's local chats array and NavigationStore's selectedChat snapshot.

import {
	normalizePermissionMode,
	normalizeThinkingMode,
} from '$shared/chat-modes';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import { createEmptyAgentSettings, normalizeAgentSettings } from '$lib/agents/agent-settings.js';
import {
	deleteChat as deleteChatApi,
	generateChatTitle,
	listChats,
	setLastSelectedChat,
} from '$lib/api/chats.js';
import { updateSessionName } from '$lib/api/settings.js';
import type { ChatSession } from '$lib/types/session';
import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';
import * as m from '$lib/paraglide/messages.js';
import type { ChatListEntry, ChatOrderGroup } from '$shared/chat-list';

export interface ChatSessionsStoreDeps {
	listChats?: typeof listChats;
	deleteChat?: typeof deleteChatApi;
	setLastSelectedChat?: typeof setLastSelectedChat;
	generateChatTitle?: typeof generateChatTitle;
	updateSessionName?: typeof updateSessionName;
	notifyError?: (message: string) => void;
}

export interface ChatSessionsPort {
	byId: Record<string, ChatSessionRecord>;
	order: string[];
	selectedChatId: string | null;
	startupByChatId: Record<string, ChatStartupConfig>;
	readonly selectedChat: ChatSessionRecord | null;
	setSelectedChatId(chatId: string | null): void;
	quietRefreshChats(): Promise<void>;
	renameChat(chatId: string, newTitle: string): Promise<boolean>;
	hasChat(chatId: string): boolean;
	isDraft(chatId: string): boolean;
	patchDraftStartup(chatId: string, patch: Partial<ChatStartupConfig>): void;
	applyStartEntry(entry: ChatListEntry): void;
	upsertServerChat(entry: ChatListEntry): void;
	removeChat(chatId: string): void;
	patchPreview(chatId: string, content: string, timestamp?: string): void;
	patchChat(chatId: string, patch: Partial<ChatSessionRecord>): void;
	patchLastReadAt(chatId: string, lastReadAt: string): void;
	isChatProcessing(chatId: string): boolean;
	applyProcessingEvent(chatId: string, isProcessing: boolean): void;
	invalidateProcessingAuthority(): void;
	reconcileProcessing(activeChatIds: Set<string>): void;
}

function normalizeExecutionFields<
	T extends {
		agentId: string;
		permissionMode?: unknown;
		thinkingMode?: unknown;
		agentSettings?: AgentSettingsEnvelope;
	},
>(
	value: T,
): Pick<ChatSessionRecord, 'permissionMode' | 'thinkingMode' | 'agentSettings'> {
	return {
		permissionMode: normalizePermissionMode(value.permissionMode),
		thinkingMode: normalizeThinkingMode(value.thinkingMode),
		agentSettings: normalizeAgentSettings(
			value.agentId,
			value.agentSettings,
			createEmptyAgentSettings(value.agentId),
		),
	};
}

function toRecord(session: ChatSession): ChatSessionRecord {
	return {
		id: session.id,
		projectPath: session.projectPath,
		effectiveProjectKey: session.effectiveProjectKey,
		projectIdentityState: 'available',
		orderGroup: session.orderGroup,
		title: session.title,
		agentId: session.agentId,
		model: session.model,
		apiProviderId: session.apiProviderId ?? null,
		modelEndpointId: session.modelEndpointId ?? null,
		modelProtocol: session.modelProtocol ?? null,
		...normalizeExecutionFields(session),
		createdAt: session.activity?.createdAt ?? null,
		lastActivityAt: session.activity?.lastActivityAt ?? null,
		lastReadAt: session.activity?.lastReadAt ?? null,
		isPinned: session.isPinned,
		isArchived: session.isArchived ?? false,
		isProcessing: session.isActive,
		isUnread: session.isUnread ?? false,
		status: 'running',
		lastMessage: session.preview?.lastMessage || undefined,
		tags: session.tags ?? [],
		firstMessage: session.preview?.firstMessage || undefined,
	};
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function sameRecord(a: ChatSessionRecord, b: ChatSessionRecord): boolean {
	return (
		a.id === b.id &&
		a.projectPath === b.projectPath &&
		a.effectiveProjectKey === b.effectiveProjectKey &&
		a.projectIdentityState === b.projectIdentityState &&
		a.orderGroup === b.orderGroup &&
		a.title === b.title &&
		a.agentId === b.agentId &&
		a.model === b.model &&
		a.apiProviderId === b.apiProviderId &&
		a.modelEndpointId === b.modelEndpointId &&
		a.modelProtocol === b.modelProtocol &&
		a.permissionMode === b.permissionMode &&
		a.thinkingMode === b.thinkingMode &&
		JSON.stringify(a.agentSettings) === JSON.stringify(b.agentSettings) &&
		a.createdAt === b.createdAt &&
		a.lastActivityAt === b.lastActivityAt &&
		a.lastReadAt === b.lastReadAt &&
		a.isPinned === b.isPinned &&
		a.isArchived === b.isArchived &&
		a.isProcessing === b.isProcessing &&
		a.isUnread === b.isUnread &&
		a.status === b.status &&
		a.lastMessage === b.lastMessage &&
		a.firstMessage === b.firstMessage &&
		arraysEqual(a.tags, b.tags)
	);
}

function reconcileActivityProjection(
	previous: ChatSessionRecord | undefined,
	next: ChatSessionRecord,
): void {
	if (!previous) return;
	let preservedLocalTimestamp = false;

	if (previous.lastActivityAt && (!next.lastActivityAt || previous.lastActivityAt > next.lastActivityAt)) {
		next.lastActivityAt = previous.lastActivityAt;
		next.lastMessage = previous.lastMessage;
		preservedLocalTimestamp = true;
	} else if (previous.lastMessage && !next.lastMessage) {
		next.lastMessage = previous.lastMessage;
	}

	if (previous.lastReadAt && (!next.lastReadAt || previous.lastReadAt > next.lastReadAt)) {
		next.lastReadAt = previous.lastReadAt;
		preservedLocalTimestamp = true;
	}

	if (preservedLocalTimestamp) {
		next.isUnread = Boolean(
			next.lastActivityAt && (!next.lastReadAt || next.lastActivityAt > next.lastReadAt),
		);
	}
}

function insertServerEntry(
	order: readonly string[],
	records: Readonly<Record<string, ChatSessionRecord>>,
	chatId: string,
	group: ChatOrderGroup,
	previous: ChatSessionRecord | undefined,
): string[] {
	const priorIndex = order.indexOf(chatId);
	const without = order.filter((id) => id !== chatId && Boolean(records[id]));
	if (previous?.status !== 'draft' && previous?.orderGroup === group && priorIndex >= 0) {
		without.splice(Math.min(priorIndex, without.length), 0, chatId);
		return without;
	}

	const groupRank: Record<ChatOrderGroup, number> = {
		pinned: 0,
		orphan: 1,
		normal: 2,
		archived: 3,
	};
	const draftCount = without.findIndex((id) => records[id]?.status !== 'draft');
	const serverStart = draftCount === -1 ? without.length : draftCount;
	let insertionIndex = serverStart;
	while (insertionIndex < without.length) {
		const record = records[without[insertionIndex]];
		if (!record || record.status === 'draft') {
			insertionIndex += 1;
			continue;
		}
		const recordGroup = record.orderGroup ?? 'orphan';
		if (groupRank[recordGroup] >= groupRank[group]) break;
		insertionIndex += 1;
	}
	if (group === 'normal') {
		without.splice(insertionIndex, 0, chatId);
		return without;
	}
	if (group === 'archived') {
		without.push(chatId);
		return without;
	}
	while (
		insertionIndex < without.length &&
		records[without[insertionIndex]]?.orderGroup === group
	) {
		insertionIndex += 1;
	}
	without.splice(insertionIndex, 0, chatId);
	if (group !== 'orphan') return without;

	const orphanIds = without.filter((id) => records[id]?.orderGroup === 'orphan');
	orphanIds.sort((a, b) => {
		const aCreated = records[a]?.createdAt ?? '';
		const bCreated = records[b]?.createdAt ?? '';
		return bCreated.localeCompare(aCreated) || a.localeCompare(b);
	});
	let orphanIndex = 0;
	return without.map((id) =>
		records[id]?.orderGroup === 'orphan' ? orphanIds[orphanIndex++] : id,
	);
}

export class ChatSessionsStore implements ChatSessionsPort {
	byId = $state<Record<string, ChatSessionRecord>>({});
	order = $state<string[]>([]);
	selectedChatId = $state<string | null>(null);
	lastSelectedChatId = $state<string | null>(null);
	startupByChatId = $state<Record<string, ChatStartupConfig>>({});
	isLoadingChats = $state(true);

	#deps: ChatSessionsStoreDeps;
	#inFlightFetch: Promise<void> | null = null;
	#needsFollowUpFetch = false;
	#selectionWriteInFlight = false;
	#selectionWritePending: string | null | undefined = undefined;
	#selectionWriteAcked: string | null = null;
	#processingSnapshot: Set<string> | null = null;
	readonly #processingOverrides = new Map<string, boolean>();

	#selectedChat = $derived.by(() => {
		if (!this.selectedChatId) return null;
		return this.byId[this.selectedChatId] ?? null;
	});

	#orderedChats = $derived.by(() =>
		this.order
			.map((id) => this.byId[id])
			.filter((chat): chat is ChatSessionRecord => Boolean(chat)),
	);

	constructor(deps: ChatSessionsStoreDeps = {}) {
		this.#deps = deps;
	}

	get selectedChat(): ChatSessionRecord | null {
		return this.#selectedChat;
	}

	get orderedChats(): ChatSessionRecord[] {
		return this.#orderedChats;
	}

	setSelectedChatId(chatId: string | null): void {
		this.selectedChatId = chatId;
	}

	async #runFetch(showLoading: boolean): Promise<void> {
		if (showLoading) this.isLoadingChats = true;
		try {
			const fetchChats = this.#deps.listChats ?? listChats;
			const res = await fetchChats();
			this.lastSelectedChatId =
				typeof res.lastSelectedChatId === 'string' ? res.lastSelectedChatId : null;
			this.upsertFromServer(res.sessions ?? []);
		} catch (err) {
			const prefix = showLoading ? 'Failed to fetch chats' : 'Quiet refresh failed';
			console.error(`[ChatSessionsStore] ${prefix}:`, err);
			this.#deps.notifyError?.(m.notifications_refresh_chats_failed());
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
		return chatId in this.byId;
	}

	/** Returns true if the chat exists and is in draft status. */
	isDraft(chatId: string): boolean {
		return this.byId[chatId]?.status === 'draft';
	}

	/** Merges server-fetched sessions into the store. Preserves object identity
	 *  for unchanged records to avoid unnecessary re-renders. Drafts that the
	 *  server now owns get their startup config cleaned up. */
	upsertFromServer(sessions: ChatSession[]): void {
		const nextById: Record<string, ChatSessionRecord> = {};
		const nextOrder: string[] = [];
		const previousServerChatIds = new Set(
			Object.values(this.byId)
				.filter((record) => record.status !== 'draft')
				.map((record) => record.id),
		);

		// Preserve drafts that the server doesn't know about yet.
		for (const [id, record] of Object.entries(this.byId)) {
			if (record.status === 'draft') {
				nextById[id] = record;
			}
		}

		const startupIdsToRemove: string[] = [];

		for (const session of sessions) {
			const next = toRecord(session);
			next.isProcessing = this.#resolveProcessing(next.id, next.isProcessing);
			const prev = this.byId[next.id];
			reconcileActivityProjection(prev, next);
			if (prev && sameRecord(prev, next)) {
				nextById[next.id] = prev;
			} else {
				nextById[next.id] = next;
			}
			nextOrder.push(next.id);

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
			this.#processingOverrides.delete(chatId);
			this.#processingSnapshot?.delete(chatId);
		}
		const draftOrder: string[] = [];
		for (const id of this.order) {
			if (nextById[id]?.status === 'draft' && !serverIdSet.has(id)) {
				draftOrder.push(id);
			}
		}

		this.byId = nextById;
		this.order = [...draftOrder, ...nextOrder];
	}

	createDraft(params: { id: string; projectPath: string; startup: ChatStartupConfig }): void {
		const { id, projectPath, startup } = params;
		const normalizedStartup = {
			...startup,
			...normalizeExecutionFields(startup),
		};

		const draft: ChatSessionRecord = {
			id,
			projectPath,
			effectiveProjectKey: null,
			projectIdentityState: 'pending',
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
			isUnread: false,
			status: 'draft',
			tags: normalizedStartup.tags ?? [],
			firstMessage: undefined,
		};

		this.byId = { ...this.byId, [id]: draft };
		this.order = this.order.includes(id) ? this.order : [id, ...this.order];
		this.startupByChatId = { ...this.startupByChatId, [id]: normalizedStartup };
		this.selectedChatId = id;
	}

	/** Updates startup configuration for an existing draft chat. */
	patchDraftStartup(chatId: string, patch: Partial<ChatStartupConfig>): void {
		const chat = this.byId[chatId];
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
		const previous = this.byId[entry.id];
		reconcileActivityProjection(previous, next);
		next.isProcessing = this.#resolveProcessing(entry.id, next.isProcessing);
		const nextById = { ...this.byId, [entry.id]: next };
		const nextOrder = insertServerEntry(this.order, nextById, entry.id, entry.orderGroup, previous);
		this.byId = nextById;
		this.order = nextOrder;
		if ((clearStartup || previous?.status === 'draft') && this.startupByChatId[entry.id]) {
			const startup = { ...this.startupByChatId };
			delete startup[entry.id];
			this.startupByChatId = startup;
		}
	}

	removeChat(chatId: string): void {
		this.#processingOverrides.delete(chatId);
		this.#processingSnapshot?.delete(chatId);
		if (!this.byId[chatId]) return;

		const nextById = { ...this.byId };
		delete nextById[chatId];

		const nextStartup = { ...this.startupByChatId };
		delete nextStartup[chatId];

		this.byId = nextById;
		this.startupByChatId = nextStartup;
		this.order = this.order.filter((id) => id !== chatId);

		if (this.selectedChatId === chatId) {
			this.selectedChatId = null;
		}
	}

	/** Patches preview text for a chat in the sidebar. */
	patchPreview(chatId: string, content: string, timestamp?: string): void {
		const chat = this.byId[chatId];
		if (!chat) return;
		if (timestamp && chat.lastActivityAt && timestamp < chat.lastActivityAt) return;
		const lastActivityAt = timestamp ?? chat.lastActivityAt;
		const isUnread = timestamp
			? Boolean(lastActivityAt && (!chat.lastReadAt || lastActivityAt > chat.lastReadAt))
			: chat.isUnread;
		if (
			(chat.lastMessage || '') === content
			&& chat.lastActivityAt === lastActivityAt
			&& chat.isUnread === isUnread
		) return;
		this.byId = {
			...this.byId,
			[chatId]: { ...chat, lastMessage: content, lastActivityAt, isUnread },
		};
	}

	/** Updates a chat record field, such as title after rename. */
	patchChat(chatId: string, patch: Partial<ChatSessionRecord>): void {
		const chat = this.byId[chatId];
		if (!chat) return;
		const nextChat = {
			...chat,
			...patch,
			...normalizeExecutionFields({ ...chat, ...patch }),
		};
		this.byId = {
			...this.byId,
			[chatId]: nextChat,
		};
	}

	/** Applies a server-confirmed lastReadAt and recomputes isUnread locally.
	 *  Avoids the race where the server computes isUnread from a lastActivity
	 *  that advances during streaming, overwriting the client's optimistic false. */
	patchLastReadAt(chatId: string, lastReadAt: string): void {
		const chat = this.byId[chatId];
		if (!chat) return;
		const reconciledLastReadAt = chat.lastReadAt && chat.lastReadAt > lastReadAt
			? chat.lastReadAt
			: lastReadAt;
		const isUnread = Boolean(
			chat.lastActivityAt && chat.lastActivityAt > reconciledLastReadAt,
		);
		if (chat.lastReadAt === reconciledLastReadAt && chat.isUnread === isUnread) return;
		this.byId = {
			...this.byId,
			[chatId]: { ...chat, lastReadAt: reconciledLastReadAt, isUnread },
		};
	}

	/** Returns WebSocket-authoritative processing state before or after list hydration. */
	isChatProcessing(chatId: string): boolean {
		return this.#resolveProcessing(chatId, this.byId[chatId]?.isProcessing ?? false);
	}

	/** Applies a WebSocket-authoritative processing event for one chat. */
	applyProcessingEvent(chatId: string, isProcessing: boolean): void {
		this.#processingOverrides.set(chatId, isProcessing);
		const chat = this.byId[chatId];
		if (!chat) return;

		if (chat.isProcessing === isProcessing) return;
		this.byId = {
			...this.byId,
			[chatId]: { ...chat, isProcessing },
		};
	}

	/** Drops authority retained from a previous socket so REST can converge state. */
	invalidateProcessingAuthority(): void {
		this.#processingSnapshot = null;
		this.#processingOverrides.clear();
	}

	/** Replaces processing state from a reconnect snapshot. Later WebSocket
	 *  events override this baseline; REST list responses never do. */
	reconcileProcessing(activeChatIds: Set<string>): void {
		this.#processingSnapshot = new Set(activeChatIds);
		this.#processingOverrides.clear();

		let changed = false;
		const nextById = { ...this.byId };

		for (const [id, record] of Object.entries(nextById)) {
			const shouldBeProcessing = activeChatIds.has(id);
			if (record.isProcessing !== shouldBeProcessing) {
				nextById[id] = { ...record, isProcessing: shouldBeProcessing };
				changed = true;
			}
		}

		if (changed) {
			this.byId = nextById;
		}
	}

	#resolveProcessing(chatId: string, restValue: boolean): boolean {
		const override = this.#processingOverrides.get(chatId);
		if (override !== undefined) return override;
		if (this.#processingSnapshot) return this.#processingSnapshot.has(chatId);
		return restValue;
	}
}

export function createChatSessionsStore(deps: ChatSessionsStoreDeps = {}): ChatSessionsStore {
	return new ChatSessionsStore(deps);
}
