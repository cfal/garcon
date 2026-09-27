import { SvelteMap } from 'svelte/reactivity';
import type { ChatDraftAppendOptions, ChatDraftAppendResult } from './chat-draft-append.js';

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

export class ChatDraftStore {
	#entries = new SvelteMap<string, ChatDraftView>();

	load(chatId: string): void {
		if (!chatId || this.#entries.has(chatId)) return;
		this.#entries.set(chatId, {
			text: '',
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
		this.setText(chatId, `${current.text}${separator}${block}`);
		return 'appended';
	}

	clear(chatId: string): number {
		if (!chatId) return 0;
		this.load(chatId);
		const revision = this.view(chatId).revision + 1;
		this.#entries.set(chatId, { text: '', attachments: [], revision });
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
		return true;
	}

	discardChat(chatId: string): void {
		if (!chatId) return;
		this.#entries.delete(chatId);
	}

	destroy(): void {
		this.#entries.clear();
	}
}
