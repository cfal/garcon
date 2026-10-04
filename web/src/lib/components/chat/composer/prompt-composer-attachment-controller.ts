import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import {
	isSupportedChatAttachment,
	type ChatAttachmentSupport,
} from '$lib/chat/composer/image-attachment.svelte.js';

interface PromptComposerAttachmentOptions {
	composer: Pick<ComposerState, 'addImages' | 'isDragActive'>;
	get attachmentInputBlocked(): boolean;
	get attachmentPickerBlocked(): boolean;
	get attachmentSupport(): ChatAttachmentSupport;
	onAttachmentInput(): void;
}

export class PromptComposerAttachmentController {
	fileInput: HTMLInputElement | undefined;
	#dragDepth = 0;

	constructor(private readonly options: PromptComposerAttachmentOptions) {}

	pick(): void {
		if (!this.options.attachmentPickerBlocked) this.fileInput?.click();
	}

	handleFileChange(event: Event): void {
		const input = event.target as HTMLInputElement;
		if (!input.files) return;
		const attachments = this.#supportedAttachments(input.files);
		if (attachments.length > 0 && !this.options.attachmentPickerBlocked) {
			this.options.composer.addImages(attachments, this.options.attachmentSupport);
		}
		input.value = '';
	}

	handleDragEnter(event: DragEvent): void {
		if (!this.#isFileDrag(event)) return;
		if (!this.options.composer.isDragActive) this.#dragDepth = 0;
		this.#dragDepth += 1;
		this.handleDragOver(event);
	}

	handleDragOver(event: DragEvent): void {
		if (!this.#isFileDrag(event)) return;
		event.preventDefault();
		event.stopPropagation();
		const support = this.options.attachmentSupport;
		const allowed =
			!this.options.attachmentInputBlocked &&
			(support.allowImages || support.fileMimeTypes.length > 0);
		if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
		this.options.composer.isDragActive = allowed;
	}

	handleDragLeave(event: DragEvent): void {
		if (!this.#isFileDrag(event)) return;
		event.stopPropagation();
		// Native file drags can omit relatedTarget when crossing descendants.
		this.#dragDepth = Math.max(0, this.#dragDepth - 1);
		if (this.#dragDepth === 0) this.resetDrag();
	}

	resetDrag(): void {
		this.#dragDepth = 0;
		this.options.composer.isDragActive = false;
	}

	handleDrop(event: DragEvent): void {
		if (!this.#isFileDrag(event)) return;
		event.preventDefault();
		event.stopPropagation();
		this.resetDrag();
		const files = event.dataTransfer?.files;
		if (!files) return;
		const attachments = this.#supportedAttachments(files);
		if (attachments.length === 0 || this.options.attachmentInputBlocked) return;
		this.options.onAttachmentInput();
		this.options.composer.addImages(attachments, this.options.attachmentSupport);
	}

	handlePaste(event: ClipboardEvent): void {
		const items = event.clipboardData?.items;
		if (!items) return;
		const images: File[] = [];
		for (const item of items) {
			if (!item.type.startsWith('image/')) continue;
			const file = item.getAsFile();
			if (file && isSupportedChatAttachment(file, this.options.attachmentSupport)) {
				images.push(file);
			}
		}
		if (images.length === 0 || this.options.attachmentInputBlocked) return;
		this.options.onAttachmentInput();
		this.options.composer.addImages(images, this.options.attachmentSupport);
	}

	#supportedAttachments(files: FileList): File[] {
		return Array.from(files).filter((file) =>
			isSupportedChatAttachment(file, this.options.attachmentSupport),
		);
	}

	#isFileDrag(event: DragEvent): boolean {
		const transfer = event.dataTransfer;
		return Boolean(transfer && (transfer.types.includes('Files') || transfer.files.length > 0));
	}
}
