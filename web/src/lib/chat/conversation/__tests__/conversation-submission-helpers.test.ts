import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	MAX_CHAT_ATTACHMENT_FILE_BYTES,
	MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
} from '@garcon/common/attachments';
import { prepareChatImages } from '../conversation-submission-helpers.js';

function file(name: string, type: string, size: number): File {
	return { name, type, size } as File;
}

describe('conversation submission attachment limits', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('rejects oversized batches before reading file data', async () => {
		const reader = vi.fn();
		vi.stubGlobal('FileReader', reader);

		await expect(
			prepareChatImages([file('clip.mp4', 'video/mp4', MAX_CHAT_ATTACHMENT_TOTAL_BYTES + 1)]),
		).rejects.toThrow('Total upload too large. Maximum combined size is 25MB.');
		expect(reader).not.toHaveBeenCalled();
	});

	it('retains the smaller per-file limit for non-video attachments', async () => {
		const reader = vi.fn();
		vi.stubGlobal('FileReader', reader);

		await expect(
			prepareChatImages([file('notes.txt', 'text/plain', MAX_CHAT_ATTACHMENT_FILE_BYTES + 1)]),
		).rejects.toThrow('File too large. Maximum file size is 10MB.');
		expect(reader).not.toHaveBeenCalled();
	});
});
