// Retains the unsent new-chat prompt so closing the dialog does not lose it.
// Text persists in this browser's localStorage; attachments are File handles
// and survive only for the page lifetime. The root draft store owns the
// debounced and page-hide writes, so the form never flushes on close.

import type { ChatDraftStore } from '$lib/chat/composer/chat-draft-store.svelte.js';

// Chat IDs are 16-digit timestamps, so this slot cannot collide with a chat.
const NEW_CHAT_DRAFT_SLOT = 'new-chat';

type ChatDraftSlots = Pick<ChatDraftStore, 'snapshot' | 'queuePersist' | 'setAttachments' | 'clear'>;

export interface NewChatPromptDraftContent {
	readonly text: string;
	readonly attachments: readonly File[];
}

export class NewChatPromptDraft {
	readonly #drafts: ChatDraftSlots;
	// Whether the form content is the retained draft. False while a prefill shows beside an
	// older unsent draft, and once the content has started a chat.
	#ownsSlot = false;
	#retainedAttachments: readonly File[] | null = null;

	constructor(drafts: ChatDraftSlots) {
		this.#drafts = drafts;
	}

	/** Returns the retained draft to seed the form, or null when an explicit prefill replaces it. */
	seed(prefill: string): NewChatPromptDraftContent | null {
		const { text, attachments } = this.#drafts.snapshot(NEW_CHAT_DRAFT_SLOT);
		this.#retainedAttachments = null;
		if (prefill) {
			// An edited prefill may take an empty slot, but never replaces an older unsent draft.
			this.#ownsSlot = !text.trim() && attachments.length === 0;
			return null;
		}
		this.#ownsSlot = true;
		return { text, attachments };
	}

	/** Records edited form content as the retained draft. */
	retain(text: string, attachments: readonly File[]): void {
		if (!this.#ownsSlot) return;
		this.#drafts.queuePersist(NEW_CHAT_DRAFT_SLOT, text);
		if (attachments === this.#retainedAttachments) return;
		this.#drafts.setAttachments(NEW_CHAT_DRAFT_SLOT, attachments);
		this.#retainedAttachments = attachments;
	}

	/** Drops the retained draft once the form content has started a chat. */
	discardSubmitted(): void {
		if (this.#ownsSlot) this.#drafts.clear(NEW_CHAT_DRAFT_SLOT);
		this.#ownsSlot = false;
	}
}
