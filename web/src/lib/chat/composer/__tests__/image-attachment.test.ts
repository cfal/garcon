import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	ImageAttachmentState,
	isImageAttachment,
	isSupportedChatAttachment,
	mimeTypeForChatAttachment,
} from '../image-attachment.svelte.js';

const createObjectURL = vi.fn<(file: File) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();

function file(name: string, type = ''): File {
	return new File(['content'], name, { type, lastModified: 42 });
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

	it('filters unsupported files and deduplicates by name', () => {
		const state = new ImageAttachmentState();
		state.add([
			file('photo.png', 'image/png'),
			file('archive.zip', 'application/zip'),
			file('notes.md'),
		]);
		state.add([file('photo.png', 'image/jpeg'), file('report.pdf')]);

		expect(state.images.map((attachment) => attachment.name)).toEqual([
			'photo.png',
			'notes.md',
			'report.pdf',
		]);
	});

	it('reuses live preview URLs and revokes stale URLs after removal', () => {
		const state = new ImageAttachmentState();
		const first = file('first.png', 'image/png');
		const second = file('second.png', 'image/png');
		state.add([first, second]);

		state.syncUrls();
		expect(state.urlFor(first, 0)).toBe('blob:test-1');
		expect(state.urlFor(second, 1)).toBe('blob:test-2');
		state.syncUrls();
		expect(createObjectURL).toHaveBeenCalledTimes(2);

		state.remove(0);
		state.syncUrls();
		expect(state.urlFor(second, 0)).toBe('blob:test-3');
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-2');

		state.clear();
		expect(state.images).toEqual([]);
		expect(state.urls.size).toBe(0);
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-3');
	});

	it('preserves explicit MIME types and falls back by extension', () => {
		expect(mimeTypeForChatAttachment(file('photo.bin', 'image/webp'))).toBe('image/webp');
		expect(mimeTypeForChatAttachment(file('notes.md'))).toBe('text/markdown');
		expect(mimeTypeForChatAttachment(file('guide.markdown'))).toBe('text/markdown');
		expect(mimeTypeForChatAttachment(file('report.pdf'))).toBe('application/pdf');
		expect(mimeTypeForChatAttachment(file('unknown.bin'))).toBe('application/octet-stream');
	});
});
