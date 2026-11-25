import { SvelteMap } from 'svelte/reactivity';
import type { ChatDraftAppendOptions, ChatDraftAppendResult } from './chat-draft-append.js';
import {
	chatDraftStorageKey,
	getLocalStorageItem,
	removeLocalStorageItem,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

const DEFAULT_DRAFT_SAVE_DELAY_MS = 250;
const MAX_EMPTY_DRAFTS = 100;
const EMPTY_ATTACHMENTS: readonly File[] = Object.freeze([]);

export interface ChatDraftView {
	readonly text: string;
	readonly attachments: readonly File[];
	readonly revision: number;
}

export interface ChatDraftSnapshot {
	readonly text: string;
	readonly attachments: readonly File[];
	readonly revision: number;
}

const EMPTY_DRAFT: ChatDraftView = Object.freeze({
	text: '',
	attachments: EMPTY_ATTACHMENTS,
	revision: 0,
});

function persistedText(chatId: string): string {
	return getLocalStorageItem(chatDraftStorageKey(chatId)) ?? '';
}

function persistText(chatId: string, text: string): void {
	const key = chatDraftStorageKey(chatId);
	if (text.trim()) setLocalStorageItem(key, text);
	else removeLocalStorageItem(key);
}

class ChatDraftEntry implements ChatDraftView {
	text = $state('');
	attachments = $state.raw<readonly File[]>(EMPTY_ATTACHMENTS);
	revision = $state(0);

	constructor(text: string) {
		this.text = text;
	}
}

export class ChatDraftStore {
	#entries = new SvelteMap<string, ChatDraftEntry>();
	#emptyUnedited = new Set<string>();
	#dirtyChatIds = new Set<string>();
	#saveTimer: ReturnType<typeof setTimeout> | null = null;
	#removePersistenceListeners: (() => void) | null = null;

	load(chatId: string): void {
		if (chatId) this.#loadEntry(chatId);
	}

	#loadEntry(chatId: string): ChatDraftEntry {
		const existing = this.#entries.get(chatId);
		if (existing) {
			if (this.#emptyUnedited.delete(chatId)) this.#emptyUnedited.add(chatId);
			return existing;
		}
		const text = persistedText(chatId);
		const entry = new ChatDraftEntry(text);
		this.#entries.set(chatId, entry);
		if (text) return entry;
		this.#emptyUnedited.add(chatId);
		if (this.#emptyUnedited.size > MAX_EMPTY_DRAFTS) {
			const oldest = this.#emptyUnedited.values().next().value;
			if (oldest !== undefined) {
				this.#emptyUnedited.delete(oldest);
				this.#entries.delete(oldest);
			}
		}
		return entry;
	}

	#editEntry(chatId: string): ChatDraftEntry {
		const entry = this.#loadEntry(chatId);
		// Edited entries retain attachments and revision fences until the chat is discarded.
		this.#emptyUnedited.delete(chatId);
		entry.revision += 1;
		return entry;
	}

	view(chatId: string): ChatDraftView {
		if (!chatId) return EMPTY_DRAFT;
		return this.#entries.get(chatId) ?? EMPTY_DRAFT;
	}

	snapshot(chatId: string): ChatDraftSnapshot {
		this.load(chatId);
		const draft = this.view(chatId);
		return {
			text: draft.text,
			attachments: [...draft.attachments],
			revision: draft.revision,
		};
	}

	setText(chatId: string, text: string): number {
		if (!chatId) return 0;
		const entry = this.#editEntry(chatId);
		entry.text = text;
		return entry.revision;
	}

	setTextAndFlush(chatId: string, text: string): number {
		const revision = this.setText(chatId, text);
		if (chatId) this.flushChat(chatId);
		return revision;
	}

	setAttachments(chatId: string, attachments: readonly File[]): number {
		if (!chatId) return 0;
		const entry = this.#editEntry(chatId);
		entry.attachments = attachments.length > 0 ? [...attachments] : EMPTY_ATTACHMENTS;
		return entry.revision;
	}

	appendBlock(
		chatId: string,
		block: string,
		options?: ChatDraftAppendOptions,
	): ChatDraftAppendResult {
		if (!chatId || !block.trim()) return 'unavailable';
		this.load(chatId);
		const current = this.view(chatId);
		if (!options?.allowDuplicate && current.text.includes(block)) return 'duplicate';
		let separator = '\n\n';
		if (current.text.length === 0 || current.text.endsWith('\n\n')) separator = '';
		else if (current.text.endsWith('\n')) separator = '\n';
		this.setTextAndFlush(chatId, `${current.text}${separator}${block}`);
		return 'appended';
	}

	queuePersist(chatId: string, text: string, delayMs = DEFAULT_DRAFT_SAVE_DELAY_MS): void {
		if (!chatId) return;
		this.load(chatId);
		if (this.view(chatId).text !== text) this.setText(chatId, text);
		this.#dirtyChatIds.add(chatId);
		if (this.#saveTimer) clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => this.flushAll(), delayMs);
	}

	flushChat(chatId: string): void {
		if (!chatId) return;
		const draft = this.#entries.get(chatId);
		if (draft) persistText(chatId, draft.text);
		this.#dirtyChatIds.delete(chatId);
		this.#clearIdleTimer();
	}

	flushAll(): void {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = null;
		}
		const dirtyChatIds = [...this.#dirtyChatIds];
		this.#dirtyChatIds.clear();
		for (const chatId of dirtyChatIds) {
			const draft = this.#entries.get(chatId);
			if (draft) persistText(chatId, draft.text);
		}
	}

	clear(chatId: string): number {
		if (!chatId) return 0;
		const entry = this.#editEntry(chatId);
		entry.text = '';
		entry.attachments = EMPTY_ATTACHMENTS;
		this.#dirtyChatIds.delete(chatId);
		removeLocalStorageItem(chatDraftStorageKey(chatId));
		this.#clearIdleTimer();
		return entry.revision;
	}

	restoreIfRevision(
		chatId: string,
		expectedRevision: number,
		snapshot: Pick<ChatDraftSnapshot, 'text' | 'attachments'>,
	): boolean {
		if (!chatId) return false;
		const current = this.#loadEntry(chatId);
		if (current.revision !== expectedRevision) return false;
		const entry = this.#editEntry(chatId);
		entry.text = snapshot.text;
		entry.attachments = snapshot.attachments.length > 0 ? [...snapshot.attachments] : EMPTY_ATTACHMENTS;
		this.flushChat(chatId);
		return true;
	}

	discardChat(chatId: string): void {
		if (!chatId) return;
		this.#entries.delete(chatId);
		this.#emptyUnedited.delete(chatId);
		this.#dirtyChatIds.delete(chatId);
		removeLocalStorageItem(chatDraftStorageKey(chatId));
		this.#clearIdleTimer();
	}

	mountPersistenceLifecycle(): () => void {
		if (this.#removePersistenceListeners || typeof window === 'undefined') return () => {};
		const flush = () => this.flushAll();
		const flushWhenHidden = () => {
			if (document.visibilityState === 'hidden') flush();
		};
		window.addEventListener('pagehide', flush);
		document.addEventListener('visibilitychange', flushWhenHidden);
		this.#removePersistenceListeners = () => {
			window.removeEventListener('pagehide', flush);
			document.removeEventListener('visibilitychange', flushWhenHidden);
			this.#removePersistenceListeners = null;
		};
		return this.#removePersistenceListeners;
	}

	destroy(): void {
		this.flushAll();
		this.#removePersistenceListeners?.();
	}

	#clearIdleTimer(): void {
		if (this.#dirtyChatIds.size > 0 || !this.#saveTimer) return;
		clearTimeout(this.#saveTimer);
		this.#saveTimer = null;
	}
}
