// Retains the unsent new-chat prompt so closing the dialog does not lose it.
// Text persists in this browser's localStorage; attachments are File handles
// and survive only for the page lifetime.

import { createRandomId } from '$lib/utils/random-id';
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

function storedText(slot: string | null): string {
	if (!slot) return '';
	try {
		const value: unknown = JSON.parse(slot);
		return value !== null && typeof value === 'object' && 'text' in value &&
			typeof value.text === 'string' ? value.text : '';
	} catch {
		return '';
	}
}

/** Owns the shared slot and retains page-local content when storage is unavailable. */
export class NewChatPromptDraftStore {
	#knownSlot: string | null = null;
	#text = '';
	#attachments: readonly File[] = [];

	read(): NewChatPromptDraftContent {
		const slot = getLocalStorageItem(SLOT_KEY);
		if (slot !== this.#knownSlot) {
			this.#text = storedText(slot);
			this.#attachments = [];
		}
		this.#knownSlot = slot;
		return { text: this.#text, attachments: this.#attachments };
	}

	/** Returns false when another tab has replaced the last observed revision. */
	write(text: string, attachments: readonly File[]): boolean {
		const previous = getLocalStorageItem(SLOT_KEY);
		if (previous !== this.#knownSlot) return false;
		// Each edit changes identity even when only the page-local attachments change.
		const next = text.trim() || attachments.length
			? JSON.stringify({ revision: createRandomId(), text })
			: null;
		if (next === null) removeLocalStorageItem(SLOT_KEY);
		else setLocalStorageItem(SLOT_KEY, next);
		const observed = getLocalStorageItem(SLOT_KEY);
		if (observed !== next && observed !== previous) return false;
		this.#knownSlot = observed;
		// Failed persistence still retains the unsent content for this page's lifetime.
		this.#text = text;
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
