// Canonical chat session store. Single source of truth for chat entities,
// selection state, and draft lifecycle. Replaces split ownership between
// AppShell's local chats array and NavigationStore's selectedChat snapshot.

import type { ChatSession } from '$lib/types/session';
import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';

function toRecord(session: ChatSession): ChatSessionRecord {
	return {
		id: session.id,
		projectPath: session.projectPath,
		title: session.title,
		provider: session.provider,
		model: session.model,
		permissionMode: (session.permissionMode as ChatSessionRecord['permissionMode']) ?? 'default',
		thinkingMode: session.thinkingMode ?? 'none',
		createdAt: session.activity?.createdAt ?? null,
		lastActivityAt: session.activity?.lastActivityAt ?? null,
		lastReadAt: session.activity?.lastReadAt ?? null,
		isPinned: session.isPinned,
		isArchived: session.isArchived ?? false,
		isProcessing: session.isActive,
		isUnread: session.isUnread ?? false,
		status: 'running',
		lastMessage: session.preview?.lastMessage || undefined,
	};
}

function sameRecord(a: ChatSessionRecord, b: ChatSessionRecord): boolean {
	return (
		a.id === b.id &&
		a.projectPath === b.projectPath &&
		a.title === b.title &&
		a.provider === b.provider &&
		a.model === b.model &&
		a.permissionMode === b.permissionMode &&
		a.thinkingMode === b.thinkingMode &&
		a.createdAt === b.createdAt &&
		a.lastActivityAt === b.lastActivityAt &&
		a.lastReadAt === b.lastReadAt &&
		a.isPinned === b.isPinned &&
		a.isArchived === b.isArchived &&
		a.isUnread === b.isUnread &&
		a.status === b.status &&
		a.lastMessage === b.lastMessage
	);
}

export class ChatSessionsStore {
	byId = $state<Record<string, ChatSessionRecord>>({});
	order = $state<string[]>([]);
	selectedChatId = $state<string | null>(null);
	startupByChatId = $state<Record<string, ChatStartupConfig>>({});

	get selectedChat(): ChatSessionRecord | null {
		if (!this.selectedChatId) return null;
		return this.byId[this.selectedChatId] ?? null;
	}

	get orderedChats(): ChatSessionRecord[] {
		return this.order
			.map((id) => this.byId[id])
			.filter((chat): chat is ChatSessionRecord => Boolean(chat));
	}

	setSelectedChatId(chatId: string | null): void {
		this.selectedChatId = chatId;
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

		for (const session of sessions) {
			const next = toRecord(session);
			const prev = this.byId[next.id];
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
				const startup = { ...this.startupByChatId };
				delete startup[next.id];
				this.startupByChatId = startup;
			}
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

	createDraft(params: {
		id: string;
		projectPath: string;
		startup: ChatStartupConfig;
	}): void {
		const { id, projectPath, startup } = params;

		const draft: ChatSessionRecord = {
			id,
			projectPath,
			title: startup.firstMessage.trim() || 'New Session',
			provider: startup.provider,
			model: startup.model,
			permissionMode: startup.permissionMode ?? 'default',
			thinkingMode: startup.thinkingMode ?? 'none',
			createdAt: null,
			lastActivityAt: null,
			lastReadAt: null,
			isPinned: false,
			isArchived: false,
			isProcessing: false,
			isUnread: false,
			status: 'draft',
		};

		this.byId = { ...this.byId, [id]: draft };
		this.order = this.order.includes(id) ? this.order : [id, ...this.order];
		this.startupByChatId = { ...this.startupByChatId, [id]: startup };
		this.selectedChatId = id;
	}

	/** Updates startup configuration for an existing draft chat. */
	patchDraftStartup(chatId: string, patch: Partial<ChatStartupConfig>): void {
		const chat = this.byId[chatId];
		if (!chat || chat.status !== 'draft') return;
		const startup = this.startupByChatId[chatId];
		if (!startup) return;
		this.startupByChatId = {
			...this.startupByChatId,
			[chatId]: {
				...startup,
				...patch,
			},
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
	patchPreview(chatId: string, content: string): void {
		const chat = this.byId[chatId];
		if (!chat) return;
		if ((chat.lastMessage || '') === content) return;
		this.byId = {
			...this.byId,
			[chatId]: { ...chat, lastMessage: content },
		};
	}

	/** Updates a chat record field, such as title after rename. */
	patchChat(chatId: string, patch: Partial<ChatSessionRecord>): void {
		const chat = this.byId[chatId];
		if (!chat) return;
		this.byId = {
			...this.byId,
			[chatId]: { ...chat, ...patch },
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

export function createChatSessionsStore(): ChatSessionsStore {
	return new ChatSessionsStore();
}
