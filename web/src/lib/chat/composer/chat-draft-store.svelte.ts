import { SvelteMap } from 'svelte/reactivity';
import type { ChatDraftAppendResult } from './chat-draft-append.js';
import {
	chatDraftStorageKey,
	getLocalStorageItem,
	removeLocalStorageItem,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

const DEFAULT_DRAFT_SAVE_DELAY_MS = 250;

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
	attachments: Object.freeze([]) as readonly File[],
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

export class ChatDraftStore {
	#entries = new SvelteMap<string, ChatDraftView>();
	#dirtyChatIds = new Set<string>();
	#saveTimer: ReturnType<typeof setTimeout> | null = null;
	#removePersistenceListeners: (() => void) | null = null;

	load(chatId: string): void {
		if (!chatId || this.#entries.has(chatId)) return;
		this.#entries.set(chatId, {
			text: persistedText(chatId),
			attachments: [],
			revision: 0,
		});
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
		this.load(chatId);
		const current = this.view(chatId);
		const revision = current.revision + 1;
		this.#entries.set(chatId, { ...current, text, revision });
		return revision;
	}

	setTextAndFlush(chatId: string, text: string): number {
		const revision = this.setText(chatId, text);
		if (chatId) this.flushChat(chatId);
		return revision;
	}

	setAttachments(chatId: string, attachments: readonly File[]): number {
		if (!chatId) return 0;
		this.load(chatId);
		const current = this.view(chatId);
		const revision = current.revision + 1;
		this.#entries.set(chatId, {
			...current,
			attachments: [...attachments],
			revision,
		});
		return revision;
	}

	appendBlock(chatId: string, block: string): ChatDraftAppendResult {
		if (!chatId || !block.trim()) return 'unavailable';
		this.load(chatId);
		const current = this.view(chatId);
		if (current.text.includes(block)) return 'duplicate';
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
		this.load(chatId);
		const revision = this.view(chatId).revision + 1;
		this.#entries.set(chatId, { text: '', attachments: [], revision });
		this.#dirtyChatIds.delete(chatId);
		removeLocalStorageItem(chatDraftStorageKey(chatId));
		this.#clearIdleTimer();
		return revision;
	}

	restoreIfRevision(
		chatId: string,
		expectedRevision: number,
		snapshot: Pick<ChatDraftSnapshot, 'text' | 'attachments'>,
	): boolean {
		if (!chatId) return false;
		this.load(chatId);
		const current = this.view(chatId);
		if (current.revision !== expectedRevision) return false;
		this.#entries.set(chatId, {
			text: snapshot.text,
			attachments: [...snapshot.attachments],
			revision: current.revision + 1,
		});
		this.flushChat(chatId);
		return true;
	}

	discardChat(chatId: string): void {
		if (!chatId) return;
		this.#entries.delete(chatId);
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
