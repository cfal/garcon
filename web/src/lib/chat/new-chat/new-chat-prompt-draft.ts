// Retains the unsent new-chat prompt so closing the dialog does not lose it.
// Text persists in this browser's localStorage; attachments are File handles
// and survive only for the page lifetime.

import {
	chatDraftStorageKey,
	getLocalStorageItem,
	removeLocalStorageItem,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

// Chat IDs are 16-digit timestamps, so this slot cannot collide with a chat's
// draft. Sharing the chat-draft prefix keeps it inside logout cleanup.
const SLOT_KEY = chatDraftStorageKey('new-chat');

export interface NewChatPromptDraftContent {
	readonly text: string;
	readonly attachments: readonly File[];
}

function persistedText(): string {
	return getLocalStorageItem(SLOT_KEY) ?? '';
}

/**
 * Owns the one slot every tab shares. Reads are always fresh, and a tab writes
 * only while the slot still holds what that tab last read or wrote, so it can
 * never replace or clear a newer draft from another tab.
 */
export class NewChatPromptDraftStore {
	#knownText = '';
	#attachments: readonly File[] = [];

	read(): NewChatPromptDraftContent {
		const text = persistedText();
		// Attachments held here belong to the text this tab wrote, not to another tab's draft.
		if (text !== this.#knownText) this.#attachments = [];
		this.#knownText = text;
		return { text, attachments: this.#attachments };
	}

	/** Returns false when another tab's draft holds the slot and the content was not written. */
	write(text: string, attachments: readonly File[]): boolean {
		if (persistedText() !== this.#knownText) return false;
		if (text.trim()) setLocalStorageItem(SLOT_KEY, text);
		else removeLocalStorageItem(SLOT_KEY);
		// Re-read rather than assume, so a refused or failed write leaves the slot unowned.
		this.#knownText = persistedText();
		this.#attachments = [...attachments];
		return true;
	}

	clear(): boolean {
		return this.write('', []);
	}
}

/** Binds one mount of the new-chat form to the shared slot. */
export class NewChatPromptDraft {
	readonly #store: NewChatPromptDraftStore;
	// Whether the form content is the retained draft. False while a prefill shows beside an
	// older unsent draft, once another tab's draft holds the slot, and once the content has
	// started a chat.
	#ownsSlot = false;

	constructor(store: NewChatPromptDraftStore) {
		this.#store = store;
	}

	/** Returns the retained draft to seed the form, or null when an explicit prefill replaces it. */
	seed(prefill: string): NewChatPromptDraftContent | null {
		const retained = this.#store.read();
		if (prefill) {
			// An edited prefill may take an empty slot, but never replaces an older unsent draft.
			this.#ownsSlot = !retained.text.trim() && retained.attachments.length === 0;
			return null;
		}
		this.#ownsSlot = true;
		return retained;
	}

	/** Records edited form content as the retained draft. */
	retain(text: string, attachments: readonly File[]): void {
		if (this.#ownsSlot) this.#ownsSlot = this.#store.write(text, attachments);
	}

	/** Drops the retained draft once the form content has started a chat. */
	discardSubmitted(): void {
		if (this.#ownsSlot) this.#store.clear();
		this.#ownsSlot = false;
	}
}
