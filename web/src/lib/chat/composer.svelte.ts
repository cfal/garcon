// Composer state: input text, image attachments, draft persistence,
// and message submission. Manages the input area lifecycle for a single chat.

const DRAFT_PREFIX = 'chat_draft_';
const DEFAULT_DRAFT_SAVE_DELAY_MS = 250;

function draftKey(chatId: string): string {
	return `${DRAFT_PREFIX}${chatId}`;
}

function writeDraft(chatId: string, text: string): void {
	if (!chatId) return;
	const key = draftKey(chatId);
	try {
		if (text.trim()) {
			localStorage.setItem(key, text);
		} else {
			localStorage.removeItem(key);
		}
	} catch {
		// Storage can be full or unavailable.
	}
}

export class ComposerState {
	inputText = $state('');
	images = $state<File[]>([]);
	isSubmitting = $state(false);
	isDragActive = $state(false);
	#draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
	#pendingDraftSave: { chatId: string; text: string } | null = null;

	/** Saves the current input text as a draft keyed by chat ID. */
	saveDraft(chatId: string): void {
		writeDraft(chatId, this.inputText);
	}

	/** Schedules draft persistence without blocking every input event. */
	queueDraftSave(chatId: string, delayMs = DEFAULT_DRAFT_SAVE_DELAY_MS): void {
		if (!chatId) return;
		this.cancelDraftSave();
		this.#pendingDraftSave = { chatId, text: this.inputText };
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
		this.clearImages();
		if (!chatId) return;
		const key = draftKey(chatId);
		try {
			const saved = localStorage.getItem(key);
			if (saved) {
				this.inputText = saved;
			}
		} catch {
			// Ignore read errors
		}
	}

	/** Removes the saved draft for the given chat ID. */
	clearDraft(chatId: string): void {
		if (!chatId) return;
		const key = draftKey(chatId);
		try {
			localStorage.removeItem(key);
		} catch {
			// Ignore removal errors
		}
	}

	/** Adds image files, filtering out duplicates by name. */
	addImages(files: File[]): void {
		const existingNames = new Set(this.images.map((f) => f.name));
		const newFiles = files.filter((f) => !existingNames.has(f.name));
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
