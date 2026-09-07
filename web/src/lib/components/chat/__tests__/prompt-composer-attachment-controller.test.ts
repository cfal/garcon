import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { ChatAttachmentSupport } from '$lib/chat/composer/image-attachment.svelte.js';
import { describe, expect, it, vi } from 'vitest';
import { PromptComposerAttachmentController } from '../prompt-composer-attachment-controller.js';

function fileTransfer(file: File): DataTransfer {
	const transfer = new DataTransfer();
	transfer.items.add(file);
	return transfer;
}

describe('PromptComposerAttachmentController', () => {
	it('keeps the picker blocked during transforms without cancelling expansion', () => {
		let pickerBlocked = true;
		const addImages = vi.fn<ComposerState['addImages']>();
		const onAttachmentInput = vi.fn();
		const onBlockedAttachmentInput = vi.fn();
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
			onBlockedAttachmentInput,
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
		expect(onBlockedAttachmentInput).toHaveBeenCalledOnce();
	});

	it('cancels expansion only when a pasted image is supported', () => {
		let support: ChatAttachmentSupport = { allowImages: false, fileMimeTypes: [] };
		const addImages = vi.fn<ComposerState['addImages']>();
		const onAttachmentInput = vi.fn();
		const onBlockedAttachmentInput = vi.fn();
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
			onBlockedAttachmentInput,
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

	it('rejects supported picker, paste, and drop input while attachment admission is blocked', () => {
		const addImages = vi.fn<ComposerState['addImages']>();
		const onAttachmentInput = vi.fn();
		const onBlockedAttachmentInput = vi.fn();
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
			onBlockedAttachmentInput,
		});
		const image = new File(['image'], 'blocked.png', { type: 'image/png' });
		const input = document.createElement('input');
		input.type = 'file';
		input.files = fileTransfer(image).files;

		controller.handleFileChange({ target: input } as unknown as Event);
		controller.handlePaste(new ClipboardEvent('paste', { clipboardData: fileTransfer(image) }));
		controller.handleDrop({
			preventDefault: vi.fn(),
			dataTransfer: fileTransfer(image),
		} as unknown as DragEvent);

		expect(onBlockedAttachmentInput).toHaveBeenCalledTimes(3);
		expect(onAttachmentInput).not.toHaveBeenCalled();
		expect(addImages).not.toHaveBeenCalled();
		expect(composer.isDragActive).toBe(false);
	});
});
