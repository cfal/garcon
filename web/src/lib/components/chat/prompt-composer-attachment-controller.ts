import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import {
	isSupportedChatAttachment,
	type ChatAttachmentSupport,
} from '$lib/chat/composer/image-attachment.svelte.js';

interface PromptComposerAttachmentOptions {
	composer: Pick<ComposerState, 'addImages' | 'isDragActive'>;
	get promptTransformPending(): boolean;
	get attachmentSupport(): ChatAttachmentSupport;
}

export class PromptComposerAttachmentController {
	fileInput: HTMLInputElement | undefined;

	constructor(private readonly options: PromptComposerAttachmentOptions) {}

	pick(): void {
		if (!this.options.promptTransformPending) this.fileInput?.click();
	}

	handleFileChange(event: Event): void {
		const input = event.target as HTMLInputElement;
		if (!input.files) return;
		if (!this.options.promptTransformPending) {
			this.options.composer.addImages(Array.from(input.files), this.options.attachmentSupport);
		}
		input.value = '';
	}

	handleDragOver(event: DragEvent): void {
		event.preventDefault();
		if (!this.options.promptTransformPending) this.options.composer.isDragActive = true;
	}

	handleDragLeave(): void {
		this.options.composer.isDragActive = false;
	}

	handleDrop(event: DragEvent): void {
		event.preventDefault();
		if (this.options.promptTransformPending) return;
		this.options.composer.isDragActive = false;
		const files = event.dataTransfer?.files;
		if (!files) return;
		const attachments = Array.from(files).filter((file) =>
			isSupportedChatAttachment(file, this.options.attachmentSupport),
		);
		this.options.composer.addImages(attachments, this.options.attachmentSupport);
	}

	handlePaste(event: ClipboardEvent): void {
		if (this.options.promptTransformPending) return;
		const items = event.clipboardData?.items;
		if (!items) return;
		const images = Array.from(items).flatMap((item) => {
			if (!item.type.startsWith('image/')) return [];
			const file = item.getAsFile();
			return file ? [file] : [];
		});
		if (images.length > 0) {
			this.options.composer.addImages(images, this.options.attachmentSupport);
		}
	}
}
