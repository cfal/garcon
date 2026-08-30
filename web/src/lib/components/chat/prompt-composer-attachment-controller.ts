import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import {
	isSupportedChatAttachment,
	type ChatAttachmentSupport,
} from '$lib/chat/composer/image-attachment.svelte.js';

interface PromptComposerAttachmentOptions {
	composer: Pick<ComposerState, 'addImages' | 'isDragActive'>;
	get attachmentInputBlocked(): boolean;
	get attachmentSupport(): ChatAttachmentSupport;
	onAttachmentInput(): void;
}

export class PromptComposerAttachmentController {
	fileInput: HTMLInputElement | undefined;

	constructor(private readonly options: PromptComposerAttachmentOptions) {}

	pick(): void {
		if (!this.options.attachmentInputBlocked) this.fileInput?.click();
	}

	handleFileChange(event: Event): void {
		const input = event.target as HTMLInputElement;
		if (!input.files) return;
		if (!this.options.attachmentInputBlocked) {
			this.options.onAttachmentInput();
			this.options.composer.addImages(Array.from(input.files), this.options.attachmentSupport);
		}
		input.value = '';
	}

	handleDragOver(event: DragEvent): void {
		event.preventDefault();
		if (!this.options.attachmentInputBlocked) this.options.composer.isDragActive = true;
	}

	handleDragLeave(): void {
		this.options.composer.isDragActive = false;
	}

	handleDrop(event: DragEvent): void {
		event.preventDefault();
		if (this.options.attachmentInputBlocked) return;
		this.options.composer.isDragActive = false;
		const files = event.dataTransfer?.files;
		if (!files) return;
		const attachments = Array.from(files).filter((file) =>
			isSupportedChatAttachment(file, this.options.attachmentSupport),
		);
		if (attachments.length === 0) return;
		this.options.onAttachmentInput();
		this.options.composer.addImages(attachments, this.options.attachmentSupport);
	}

	handlePaste(event: ClipboardEvent): void {
		if (this.options.attachmentInputBlocked) return;
		const items = event.clipboardData?.items;
		if (!items) return;
		const images: File[] = [];
		for (const item of items) {
			if (!item.type.startsWith('image/')) continue;
			const file = item.getAsFile();
			if (file) images.push(file);
		}
		if (images.length > 0) {
			this.options.onAttachmentInput();
			this.options.composer.addImages(images, this.options.attachmentSupport);
		}
	}
}
