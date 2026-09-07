import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	chatAttachmentAccept,
	ImageAttachmentState,
	isImageAttachment,
	isSupportedChatAttachment,
	mimeTypeForChatAttachment,
} from '../image-attachment.svelte.js';

const createObjectURL = vi.fn<(file: File) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();

function file(name: string, type = '', contents = 'content'): File {
	return new File([contents], name, { type, lastModified: 42 });
}

describe('image attachment state', () => {
	beforeEach(() => {
		let nextUrl = 1;
		createObjectURL.mockImplementation(() => `blob:test-${nextUrl++}`);
		revokeObjectURL.mockReset();
		vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it('recognizes supported image and document attachments', () => {
		expect(isImageAttachment(file('photo.png', 'image/png'))).toBe(true);
		expect(isSupportedChatAttachment(file('photo.png', 'image/png'))).toBe(true);
		expect(isSupportedChatAttachment(file('notes.txt', 'text/plain'))).toBe(true);
		expect(isSupportedChatAttachment(file('notes.md'))).toBe(true);
		expect(isSupportedChatAttachment(file('guide.markdown'))).toBe(true);
		expect(isSupportedChatAttachment(file('report.pdf'))).toBe(true);
		expect(isSupportedChatAttachment(file('archive.zip', 'application/zip'))).toBe(false);
	});

	it('accepts only video formats advertised by the selected agent', () => {
		const support = { allowImages: false, fileMimeTypes: ['video/mp4', 'video/quicktime'] };
		expect(isSupportedChatAttachment(file('clip.mp4', 'video/mp4'), support)).toBe(true);
		expect(isSupportedChatAttachment(file('clip.m4v', 'video/x-m4v'), support)).toBe(true);
		expect(isSupportedChatAttachment(file('clip.mov'), support)).toBe(true);
		expect(isSupportedChatAttachment(file('clip.webm', 'video/webm'), support)).toBe(false);
		expect(isSupportedChatAttachment(file('photo.png', 'image/png'), support)).toBe(false);
		expect(chatAttachmentAccept(support)).toContain('.mp4');
		expect(chatAttachmentAccept(support)).toContain('.m4v');
		expect(chatAttachmentAccept(support)).not.toContain('image/*');
	});

	it('deduplicates by File identity while preserving distinct same-metadata files', () => {
		const state = new ImageAttachmentState();
		const first = file('same.png', 'image/png', 'content');
		const second = file('same.png', 'image/png', 'changed');
		state.add([first, second, first, file('archive.zip', 'application/zip')]);
		state.add([first, file('notes.md')]);

		expect(state.images).toEqual([first, second, expect.objectContaining({ name: 'notes.md' })]);
	});

	it('keeps the surviving preview URL and revokes only removed image URLs', () => {
		const state = new ImageAttachmentState();
		const first = file('same.png', 'image/png', 'content');
		const second = file('same.png', 'image/png', 'changed');
		state.add([first, second]);

		state.syncUrls();
		expect(state.urlFor(first, 0)).toBe('blob:test-1');
		expect(state.urlFor(second, 1)).toBe('blob:test-2');
		state.remove(0);
		state.syncUrls();

		expect(state.urlFor(second, 0)).toBe('blob:test-2');
		expect(createObjectURL).toHaveBeenCalledTimes(2);
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1');

		state.clear();
		expect(state.images).toEqual([]);
		expect(state.urls.size).toBe(0);
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-2');
	});

	it('does not allocate preview object URLs for video files', () => {
		const state = new ImageAttachmentState();
		const video = file('clip.mp4', 'video/mp4');
		state.add([video], { allowImages: false, fileMimeTypes: ['video/mp4'] });
		state.syncUrls();
		expect(state.urlFor(video, 0)).toBeUndefined();
		expect(createObjectURL).not.toHaveBeenCalled();
	});

	it('preserves explicit MIME types and falls back by extension', () => {
		expect(mimeTypeForChatAttachment(file('photo.bin', 'image/webp'))).toBe('image/webp');
		expect(mimeTypeForChatAttachment(file('notes.md'))).toBe('text/markdown');
		expect(mimeTypeForChatAttachment(file('guide.markdown'))).toBe('text/markdown');
		expect(mimeTypeForChatAttachment(file('report.pdf'))).toBe('application/pdf');
		expect(mimeTypeForChatAttachment(file('clip.m4v', 'video/x-m4v'))).toBe('video/mp4');
		expect(mimeTypeForChatAttachment(file('unknown.bin'))).toBe('application/octet-stream');
	});
});
