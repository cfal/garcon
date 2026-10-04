import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { ChatAttachmentSupport } from '$lib/chat/composer/image-attachment.svelte.js';
import { describe, expect, it, vi } from 'vitest';
import { PromptComposerAttachmentController } from '../prompt-composer-attachment-controller.js';

function fileTransfer(file: File): DataTransfer {
	const transfer = new DataTransfer();
	transfer.items.add(file);
	return transfer;
}

function dragEvent(type: string, transfer: DataTransfer): DragEvent {
	const event = new DragEvent(type, { cancelable: true });
	// Happy DOM does not initialize DragEvent.dataTransfer from the constructor.
	Object.defineProperty(event, 'dataTransfer', { value: transfer });
	return event;
}

describe('PromptComposerAttachmentController', () => {
	it('keeps the picker blocked during transforms without cancelling expansion', () => {
		let pickerBlocked = true;
		const addImages = vi.fn<ComposerState['addImages']>();
		const onAttachmentInput = vi.fn();
		const support: ChatAttachmentSupport = { allowImages: true, fileMimeTypes: [] };
		const controller = new PromptComposerAttachmentController({
			composer: { addImages, isDragActive: false },
			get attachmentInputBlocked() {
				return false;
			},
			get attachmentPickerBlocked() {
				return pickerBlocked;
			},
			get attachmentSupport() {
				return support;
			},
			onAttachmentInput,
		});
		const input = document.createElement('input');
		input.type = 'file';
		const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
		controller.fileInput = input;
		input.addEventListener('change', (event) => controller.handleFileChange(event));
		const image = new File(['image'], 'picked.png', { type: 'image/png' });
		input.files = fileTransfer(image).files;

		controller.pick();
		input.dispatchEvent(new Event('change'));
		expect(click).not.toHaveBeenCalled();
		expect(addImages).not.toHaveBeenCalled();

		pickerBlocked = false;
		input.files = fileTransfer(image).files;
		controller.pick();
		input.dispatchEvent(new Event('change'));
		expect(click).toHaveBeenCalledOnce();
		expect(addImages).toHaveBeenCalledWith([image], support);
		expect(onAttachmentInput).not.toHaveBeenCalled();
	});

	it('cancels expansion only when a pasted image is supported', () => {
		let support: ChatAttachmentSupport = { allowImages: false, fileMimeTypes: [] };
		const addImages = vi.fn<ComposerState['addImages']>();
		const onAttachmentInput = vi.fn();
		const controller = new PromptComposerAttachmentController({
			composer: { addImages, isDragActive: false },
			get attachmentInputBlocked() {
				return false;
			},
			get attachmentPickerBlocked() {
				return false;
			},
			get attachmentSupport() {
				return support;
			},
			onAttachmentInput,
		});
		const image = new File(['image'], 'pasted.png', { type: 'image/png' });

		controller.handlePaste(new ClipboardEvent('paste', { clipboardData: fileTransfer(image) }));
		expect(onAttachmentInput).not.toHaveBeenCalled();
		expect(addImages).not.toHaveBeenCalled();

		support = { allowImages: true, fileMimeTypes: [] };
		controller.handlePaste(new ClipboardEvent('paste', { clipboardData: fileTransfer(image) }));
		expect(onAttachmentInput).toHaveBeenCalledOnce();
		expect(addImages).toHaveBeenCalledWith([image], support);
	});

	it('ignores supported picker, paste, and drop input while attachment input is blocked', () => {
		const addImages = vi.fn<ComposerState['addImages']>();
		const onAttachmentInput = vi.fn();
		const support: ChatAttachmentSupport = { allowImages: true, fileMimeTypes: [] };
		const composer = { addImages, isDragActive: true };
		const controller = new PromptComposerAttachmentController({
			composer,
			get attachmentInputBlocked() {
				return true;
			},
			get attachmentPickerBlocked() {
				return true;
			},
			get attachmentSupport() {
				return support;
			},
			onAttachmentInput,
		});
		const image = new File(['image'], 'blocked.png', { type: 'image/png' });
		const input = document.createElement('input');
		input.type = 'file';
		input.files = fileTransfer(image).files;

		input.addEventListener('change', (event) => controller.handleFileChange(event));
		input.dispatchEvent(new Event('change'));
		controller.handlePaste(new ClipboardEvent('paste', { clipboardData: fileTransfer(image) }));
		controller.handleDragOver(dragEvent('dragover', fileTransfer(image)));
		expect(composer.isDragActive).toBe(false);
		const drop = dragEvent('drop', fileTransfer(image));
		controller.handleDrop(drop);
		expect(drop.defaultPrevented).toBe(true);

		expect(onAttachmentInput).not.toHaveBeenCalled();
		expect(addImages).not.toHaveBeenCalled();
		expect(composer.isDragActive).toBe(false);
	});

	it('filters mixed drops using the current provider attachment support', () => {
		const addImages = vi.fn<ComposerState['addImages']>();
		const onAttachmentInput = vi.fn();
		let support: ChatAttachmentSupport = {
			allowImages: true,
			fileMimeTypes: ['text/markdown', 'video/mp4'],
		};
		const composer = { addImages, isDragActive: false };
		const controller = new PromptComposerAttachmentController({
			composer,
			attachmentInputBlocked: false,
			attachmentPickerBlocked: false,
			get attachmentSupport() {
				return support;
			},
			onAttachmentInput,
		});
		const image = new File(['image'], 'image.png', { type: 'image/png' });
		const notes = new File(['notes'], 'notes.md');
		const video = new File(['video'], 'video.mp4', { type: 'video/mp4' });
		const archive = new File(['archive'], 'archive.zip', { type: 'application/zip' });
		const transfer = new DataTransfer();
		for (const file of [image, notes, video, archive]) transfer.items.add(file);
		controller.handleDragEnter(dragEvent('dragenter', transfer));
		expect(transfer.dropEffect).toBe('copy');
		expect(composer.isDragActive).toBe(true);

		support = { allowImages: false, fileMimeTypes: ['text/markdown'] };
		controller.handleDrop(dragEvent('drop', transfer));
		expect(addImages).toHaveBeenCalledWith([notes], support);
		expect(onAttachmentInput).toHaveBeenCalledOnce();
		expect(composer.isDragActive).toBe(false);

		controller.handleDrop(dragEvent('drop', fileTransfer(archive)));
		expect(addImages).toHaveBeenCalledOnce();
		expect(onAttachmentInput).toHaveBeenCalledOnce();
	});
});
