// Retains the unsent new-chat prompt so closing the dialog does not lose it.
// Text persists in this browser's localStorage; attachments are File handles
// and survive only for the page lifetime.

import { createRandomId } from '$lib/utils/random-id';
import { parseChatId, type ChatId } from '$shared/chat-id';
import { createClientChatId } from '$shared/client-chat-id';
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
	readonly prospectiveChatId?: ChatId;
}

function storedContent(slot: string | null): Omit<NewChatPromptDraftContent, 'attachments'> {
	const content: { text: string; prospectiveChatId?: ChatId } = { text: '' };
	if (!slot) return content;
	try {
		const value: unknown = JSON.parse(slot);
		if (value !== null && typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
			content.text = value.text;
			if ('prospectiveChatId' in value) content.prospectiveChatId = parseChatId(value.prospectiveChatId);
		}
	} catch {
		// An invalid ID must not discard otherwise valid prompt text.
	}
	return content;
}

/** Owns the shared slot and retains page-local content when storage is unavailable. */
export class NewChatPromptDraftStore {
	#knownSlot: string | null = null;
	#content: Omit<NewChatPromptDraftContent, 'attachments'> = { text: '' };
	#attachments: readonly File[] = [];

	read(): NewChatPromptDraftContent {
		const slot = getLocalStorageItem(SLOT_KEY);
		if (slot !== this.#knownSlot) {
			this.#content = storedContent(slot);
			this.#attachments = [];
		}
		this.#knownSlot = slot;
		return { ...this.#content, attachments: this.#attachments };
	}

	/** Returns false when another tab has replaced the last observed revision. */
	write(text: string, attachments: readonly File[], prospectiveChatId?: ChatId): boolean {
		const previous = getLocalStorageItem(SLOT_KEY);
		if (previous !== this.#knownSlot) return false;
		const hasContent = Boolean(text.trim() || attachments.length);
		const content = { text, ...(hasContent && prospectiveChatId ? { prospectiveChatId } : {}) };
		// Each edit changes identity even when only the page-local attachments change.
		const next = hasContent
			? JSON.stringify({ revision: createRandomId(), ...content })
			: null;
		if (next === null) removeLocalStorageItem(SLOT_KEY);
		else setLocalStorageItem(SLOT_KEY, next);
		const observed = getLocalStorageItem(SLOT_KEY);
		if (observed !== next && observed !== previous) return false;
		this.#knownSlot = observed;
		// Failed persistence still retains the unsent content for this page's lifetime.
		this.#content = content;
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
	#prospectiveChatId: ChatId | undefined;

	constructor(store: NewChatPromptDraftStore) {
		this.#store = store;
	}

	/** Returns the retained draft to seed the form, or null when an explicit prefill replaces it. */
	seed(prefill: string, prospectiveChatId?: ChatId): NewChatPromptDraftContent | null {
		const retained = this.#store.read();
		if (prefill) {
			this.#prospectiveChatId = prospectiveChatId;
			// An edited prefill may take an empty slot, but never replaces an older unsent draft.
			this.#ownsSlot = !retained.text.trim() && retained.attachments.length === 0;
			return null;
		}
		this.#ownsSlot = true;
		this.#prospectiveChatId = retained.prospectiveChatId;
		return retained;
	}

	ensureProspectiveChatId(): ChatId {
		return this.#prospectiveChatId ??= createClientChatId();
	}

	/** Records edited form content as the retained draft. */
	retain(text: string, attachments: readonly File[]): void {
		if (!text.trim() && attachments.length === 0) this.#prospectiveChatId = undefined;
		if (this.#ownsSlot) this.#ownsSlot = this.#store.write(text, attachments, this.#prospectiveChatId);
	}

	/** Drops the retained draft once the form content has started a chat. */
	discardSubmitted(): void {
		if (this.#ownsSlot) this.#store.clear();
		this.#ownsSlot = false;
	}
}
