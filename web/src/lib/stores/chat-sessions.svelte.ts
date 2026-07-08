// Canonical chat session store. Single source of truth for chat entities,
// selection state, and draft lifecycle. Replaces split ownership between
// AppShell's local chats array and NavigationStore's selectedChat snapshot.

import {
	normalizeAmpAgentMode,
	normalizeClaudeThinkingMode,
	normalizePermissionMode,
	normalizeThinkingMode,
} from '$shared/chat-modes';
import {
	deleteChat as deleteChatApi,
	generateChatTitle,
	getRunningChats,
	listChats,
	setLastSelectedChat,
} from '$lib/api/chats.js';
import { updateSessionName } from '$lib/api/settings.js';
import type { ChatSession } from '$lib/types/session';
import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';
import * as m from '$lib/paraglide/messages.js';

export interface ChatSessionsStoreDeps {
	listChats?: typeof listChats;
	getRunningChats?: typeof getRunningChats;
	deleteChat?: typeof deleteChatApi;
	setLastSelectedChat?: typeof setLastSelectedChat;
	generateChatTitle?: typeof generateChatTitle;
	updateSessionName?: typeof updateSessionName;
	notifyError?: (message: string) => void;
}

function normalizeModeFields<
	T extends {
		permissionMode?: unknown;
		thinkingMode?: unknown;
		claudeThinkingMode?: unknown;
		ampAgentMode?: unknown;
	},
>(
	value: T,
): Pick<
	ChatSessionRecord,
	'permissionMode' | 'thinkingMode' | 'claudeThinkingMode' | 'ampAgentMode'
> {
	return {
		permissionMode: normalizePermissionMode(value.permissionMode),
		thinkingMode: normalizeThinkingMode(value.thinkingMode),
		claudeThinkingMode: normalizeClaudeThinkingMode(value.claudeThinkingMode),
		ampAgentMode: normalizeAmpAgentMode(value.ampAgentMode),
	};
}

function toRecord(session: ChatSession): ChatSessionRecord {
	return {
		id: session.id,
		projectPath: session.projectPath,
		title: session.title,
		agentId: session.agentId,
		model: session.model,
		apiProviderId: session.apiProviderId ?? null,
		modelEndpointId: session.modelEndpointId ?? null,
		modelProtocol: session.modelProtocol ?? null,
		...normalizeModeFields(session),
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
		a.title === b.title &&
		a.agentId === b.agentId &&
		a.model === b.model &&
		a.apiProviderId === b.apiProviderId &&
		a.modelEndpointId === b.modelEndpointId &&
		a.modelProtocol === b.modelProtocol &&
		a.permissionMode === b.permissionMode &&
		a.thinkingMode === b.thinkingMode &&
		a.claudeThinkingMode === b.claudeThinkingMode &&
		a.ampAgentMode === b.ampAgentMode &&
		a.createdAt === b.createdAt &&
		a.lastActivityAt === b.lastActivityAt &&
		a.lastReadAt === b.lastReadAt &&
		a.isPinned === b.isPinned &&
		a.isArchived === b.isArchived &&
		a.isUnread === b.isUnread &&
		a.status === b.status &&
		a.lastMessage === b.lastMessage &&
		a.firstMessage === b.firstMessage &&
		arraysEqual(a.tags, b.tags)
	);
}

function preserveLocalPreview(prev: ChatSessionRecord | undefined, next: ChatSessionRecord): void {
	if (prev?.lastMessage && !next.lastMessage) {
		next.lastMessage = prev.lastMessage;
	}
}

export class ChatSessionsStore {
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

	/** Refreshes sessions before reconciling the real-time processing snapshot. */
	async refreshChatsAndReconcileProcessing(): Promise<void> {
		await this.quietRefreshChats();
		const fetchRunningChats = this.#deps.getRunningChats ?? getRunningChats;
		const running = await fetchRunningChats();
		const activeChatIds = new Set<string>();
		for (const sessionsForProvider of Object.values(running.sessions)) {
			for (const session of sessionsForProvider) {
				if (session.id) activeChatIds.add(session.id);
			}
		}
		this.reconcileProcessing(activeChatIds);
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

	async renameChat(chatId: string, newTitle: string): Promise<void> {
		try {
			const renameRemoteChat = this.#deps.updateSessionName ?? updateSessionName;
			await renameRemoteChat(chatId, newTitle);
		} catch (err) {
			console.error('[ChatSessionsStore] Rename failed:', err);
			this.#deps.notifyError?.(m.notifications_rename_chat_failed());
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

		// Preserve drafts that the server doesn't know about yet.
		for (const [id, record] of Object.entries(this.byId)) {
			if (record.status === 'draft') {
				nextById[id] = record;
			}
		}

		const startupIdsToRemove: string[] = [];

		for (const session of sessions) {
			const next = toRecord(session);
			const prev = this.byId[next.id];
			preserveLocalPreview(prev, next);
			if (prev && sameRecord(prev, next)) {
				nextById[next.id] = prev;
			} else {
				// Preserve WS-authoritative isProcessing flag; the REST
				// isActive snapshot can lag behind real-time WS events.
				if (prev?.isProcessing && !next.isProcessing) {
					next.isProcessing = true;
				}
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
			...normalizeModeFields(startup),
		};

		const draft: ChatSessionRecord = {
			id,
			projectPath,
			title: normalizedStartup.firstMessage.trim() || m.chat_sessions_new_session(),
			agentId: normalizedStartup.agentId,
			model: normalizedStartup.model,
			apiProviderId: normalizedStartup.apiProviderId ?? null,
			modelEndpointId: normalizedStartup.modelEndpointId ?? null,
			modelProtocol: normalizedStartup.modelProtocol ?? null,
			...normalizeModeFields(normalizedStartup),
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
			...normalizeModeFields({ ...startup, ...patch }),
		};
		this.startupByChatId = {
			...this.startupByChatId,
			[chatId]: nextStartup,
		};
	}

	promoteDraft(chatId: string): void {
		const chat = this.byId[chatId];
		if (!chat || chat.status !== 'draft') return;

		this.byId = {
			...this.byId,
			[chatId]: {
				...chat,
				status: 'running',
			},
		};

		if (this.startupByChatId[chatId]) {
			const startup = { ...this.startupByChatId };
			delete startup[chatId];
			this.startupByChatId = startup;
		}
	}

	removeChat(chatId: string): void {
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
		const lastActivityAt = timestamp ?? chat.lastActivityAt;
		if ((chat.lastMessage || '') === content && chat.lastActivityAt === lastActivityAt) return;
		this.byId = {
			...this.byId,
			[chatId]: { ...chat, lastMessage: content, lastActivityAt },
		};
	}

	/** Updates a chat record field, such as title after rename. */
	patchChat(chatId: string, patch: Partial<ChatSessionRecord>): void {
		const chat = this.byId[chatId];
		if (!chat) return;
		const nextChat = {
			...chat,
			...patch,
			...normalizeModeFields({ ...chat, ...patch }),
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
		const isUnread = Boolean(chat.lastActivityAt && chat.lastActivityAt > lastReadAt);
		if (chat.lastReadAt === lastReadAt && chat.isUnread === isUnread) return;
		this.byId = {
			...this.byId,
			[chatId]: { ...chat, lastReadAt, isUnread },
		};
	}

	/** Sets the processing flag for a single chat. No-op if the chat
	 *  doesn't exist or the value is already correct. */
	setChatProcessing(chatId: string, isProcessing: boolean): void {
		const chat = this.byId[chatId];
		if (!chat || chat.isProcessing === isProcessing) return;
		this.byId = {
			...this.byId,
			[chatId]: { ...chat, isProcessing },
		};
	}

	/** Reconciles processing state from a server-authoritative snapshot.
	 *  Only mutates records whose isProcessing value actually differs
	 *  from the snapshot to avoid unnecessary Svelte reactivity triggers.
	 *
	 *  NOTE: A narrow race exists where a snapshot arrives slightly after
	 *  a turn_complete event, briefly re-setting isProcessing=true for a
	 *  just-finished chat. This is self-healing -- the next lifecycle
	 *  event corrects it. */
	reconcileProcessing(activeChatIds: Set<string>): void {
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
}

export function createChatSessionsStore(deps: ChatSessionsStoreDeps = {}): ChatSessionsStore {
	return new ChatSessionsStore(deps);
}
