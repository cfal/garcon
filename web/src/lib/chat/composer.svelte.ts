// Composer state: input text, image attachments, draft persistence,
// and message submission. Manages the input area lifecycle for a single chat.

	const DRAFT_PREFIX = 'chat_draft_';

export class ComposerState {
	inputText = $state('');
	images = $state<File[]>([]);
	isSubmitting = $state(false);
	isDragActive = $state(false);

	/** Saves the current input text as a draft keyed by chat ID. */
	saveDraft(chatId: string): void {
		if (!chatId) return;
		const key = `${DRAFT_PREFIX}${chatId}`;
		try {
			if (this.inputText.trim()) {
				localStorage.setItem(key, this.inputText);
			} else {
				localStorage.removeItem(key);
			}
		} catch {
			// Storage full or unavailable
		}
	}

	/** Restores a previously saved draft for the given chat ID. */
	restoreDraft(chatId: string): void {
		this.inputText = '';
		this.clearImages();
		if (!chatId) return;
		const key = `${DRAFT_PREFIX}${chatId}`;
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
		const key = `${DRAFT_PREFIX}${chatId}`;
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
		this.inputText = '';
		this.images = [];
		this.clearDraft(chatId);
	}

}

export function createComposerState(): ComposerState {
	return new ComposerState();
}
