// Composer state: input text, image attachments, draft persistence,
// and message submission. Manages the input area lifecycle for a single chat.

import {
	chatDraftStorageKey,
	getLocalStorageItem,
	removeLocalStorageItem,
	setLocalStorageItem,
	type ChatDraftStorageKey,
} from '$lib/utils/local-persistence';
import { isSupportedChatAttachment } from '$lib/chat/composer/image-attachment.svelte.js';
import type { ChatDraftAppendResult } from '$lib/chat/composer/chat-draft-append.js';

const DEFAULT_DRAFT_SAVE_DELAY_MS = 250;

function draftKey(chatId: string): ChatDraftStorageKey {
	return chatDraftStorageKey(chatId);
}

function writeDraft(chatId: string, text: string): void {
	if (!chatId) return;
	const key = draftKey(chatId);
	if (text.trim()) {
		setLocalStorageItem(key, text);
	} else {
		removeLocalStorageItem(key);
	}
}

export class ComposerState {
	inputText = $state('');
	images = $state<File[]>([]);
	isSubmitting = $state(false);
	isDragActive = $state(false);
	draftAppendRequest = $state<{ chatId: string; requestId: number } | null>(null);
	#draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
	#pendingDraftSave: { chatId: string; text: string } | null = null;
	#draftImagesByChatId = new Map<string, File[]>();
	#nextDraftAppendRequestId = 0;

	/** Appends an editable block to the active draft without submitting it. */
	appendDraftBlock(chatId: string, block: string): ChatDraftAppendResult {
		if (!chatId || !block.trim()) return 'unavailable';
		if (this.inputText.includes(block)) return 'duplicate';
		const separator =
			this.inputText.length === 0
				? ''
				: this.inputText.endsWith('\n\n')
					? ''
					: this.inputText.endsWith('\n')
						? '\n'
						: '\n\n';
		this.inputText = `${this.inputText}${separator}${block}`;
		this.#nextDraftAppendRequestId += 1;
		this.draftAppendRequest = { chatId, requestId: this.#nextDraftAppendRequestId };
		this.cancelDraftSave(chatId);
		this.saveDraft(chatId);
		return 'appended';
	}

	/** Saves the current text and in-memory attachments as a draft keyed by chat ID. */
	saveDraft(chatId: string): void {
		if (!chatId) return;
		writeDraft(chatId, this.inputText);
		if (this.images.length > 0) {
			this.#draftImagesByChatId.set(chatId, [...this.images]);
		} else {
			this.#draftImagesByChatId.delete(chatId);
		}
	}

	/** Schedules draft persistence without blocking every input event. */
	queueDraftSave(chatId: string, text: string, delayMs = DEFAULT_DRAFT_SAVE_DELAY_MS): void {
		if (!chatId) return;
		this.cancelDraftSave();
		this.#pendingDraftSave = { chatId, text };
		this.#draftSaveTimer = setTimeout(() => {
			this.flushDraftSave();
		}, delayMs);
	}

	/** Persists the latest queued draft immediately. */
	flushDraftSave(): void {
		if (this.#draftSaveTimer) {
			clearTimeout(this.#draftSaveTimer);
			this.#draftSaveTimer = null;
		}
		const pending = this.#pendingDraftSave;
		this.#pendingDraftSave = null;
		if (pending) writeDraft(pending.chatId, pending.text);
	}

	/** Drops a queued draft write, optionally scoped to one chat. */
	cancelDraftSave(chatId?: string): void {
		if (chatId && this.#pendingDraftSave?.chatId !== chatId) return;
		if (this.#draftSaveTimer) {
			clearTimeout(this.#draftSaveTimer);
			this.#draftSaveTimer = null;
		}
		this.#pendingDraftSave = null;
	}

	/** Restores a previously saved draft for the given chat ID. */
	restoreDraft(chatId: string): void {
		this.cancelDraftSave();
		this.inputText = '';
		this.images = [];
		if (!chatId) return;
		const key = draftKey(chatId);
		const saved = getLocalStorageItem(key);
		if (saved) {
			this.inputText = saved;
		}
		this.images = [...(this.#draftImagesByChatId.get(chatId) ?? [])];
	}

	/** Removes the saved draft for the given chat ID. */
	clearDraft(chatId: string): void {
		if (!chatId) return;
		const key = draftKey(chatId);
		removeLocalStorageItem(key);
		this.#draftImagesByChatId.delete(chatId);
	}

	/** Adds supported attachment files, filtering out duplicates by name. */
	addImages(files: File[]): void {
		const existingNames = new Set(this.images.map((f) => f.name));
		const newFiles = files
			.filter(isSupportedChatAttachment)
			.filter((f) => !existingNames.has(f.name));
		this.images = [...this.images, ...newFiles];
	}

	/** Removes an image at the given index. */
	removeImage(index: number): void {
		this.images = this.images.filter((_, i) => i !== index);
	}

	/** Clears all attached images. */
	clearImages(): void {
		this.images = [];
	}

	/** Resets input text, images, and draft for the given chat. */
	clearAfterSubmit(chatId: string): void {
		this.cancelDraftSave(chatId);
		this.inputText = '';
		this.images = [];
		this.clearDraft(chatId);
	}
}

export function createComposerState(): ComposerState {
	return new ComposerState();
}
