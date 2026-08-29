import {
	isSupportedChatAttachment,
	type ChatAttachmentSupport,
} from '$lib/chat/composer/image-attachment.svelte.js';
import type { ChatDraftAppendResult } from '$lib/chat/composer/chat-draft-append.js';
import {
	ChatDraftStore,
	type ChatDraftSnapshot,
} from '$lib/chat/composer/chat-draft-store.svelte.js';

interface ComposerStateOptions {
	readonly activeChatId: string | null;
}

export class ComposerState {
	isSubmitting = $state(false);
	isDragActive = $state(false);
	draftAppendRequest = $state<{ chatId: string; requestId: number } | null>(null);
	#nextDraftAppendRequestId = 0;

	constructor(
		private readonly drafts: ChatDraftStore,
		private readonly options: ComposerStateOptions,
	) {}

	#activeChatId(): string {
		return this.options.activeChatId ?? '';
	}

	get inputText(): string {
		return this.drafts.view(this.#activeChatId()).text;
	}

	set inputText(value: string) {
		this.drafts.setText(this.#activeChatId(), value);
	}

	get images(): File[] {
		return [...this.drafts.view(this.#activeChatId()).attachments];
	}

	set images(value: File[]) {
		this.drafts.setAttachments(this.#activeChatId(), value);
	}

	get contentRevision(): number {
		return this.drafts.view(this.#activeChatId()).revision;
	}

	/** Appends an editable block to the active draft without submitting it. */
	appendDraftBlock(chatId: string, block: string): ChatDraftAppendResult {
		const result = this.drafts.appendBlock(chatId, block);
		if (result !== 'appended') return result;
		this.#nextDraftAppendRequestId += 1;
		this.draftAppendRequest = { chatId, requestId: this.#nextDraftAppendRequestId };
		return result;
	}

	saveDraft(chatId: string): void {
		this.drafts.flushChat(chatId);
	}

	queueDraftSave(chatId: string, text: string, delayMs?: number): void {
		this.drafts.queuePersist(chatId, text, delayMs);
	}

	restoreDraft(chatId: string): void {
		this.drafts.load(chatId);
	}

	draftSnapshot(chatId: string): ChatDraftSnapshot {
		return this.drafts.snapshot(chatId);
	}

	draftRevision(chatId: string): number {
		return this.drafts.view(chatId).revision;
	}

	restoreDraftIfRevision(
		chatId: string,
		expectedRevision: number,
		text: string,
		images: readonly File[],
	): boolean {
		return this.drafts.restoreIfRevision(chatId, expectedRevision, {
			text,
			attachments: images,
		});
	}

	isDraftEmpty(chatId: string): boolean {
		const draft = this.drafts.view(chatId);
		return draft.text.length === 0 && draft.attachments.length === 0;
	}

	/** Adds supported attachment files, deduplicating by File identity. */
	addImages(files: File[], support?: ChatAttachmentSupport): void {
		const seen = new Set(this.images);
		const newFiles = files.filter((file) => {
			if (seen.has(file) || !isSupportedChatAttachment(file, support)) return false;
			seen.add(file);
			return true;
		});
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

	clearAfterSubmit(chatId: string): number {
		return this.drafts.clear(chatId);
	}
}
