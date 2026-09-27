import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatDraftStore } from '../chat-draft-store.svelte.js';

describe('ChatDraftStore', () => {
	afterEach(() => {
		vi.useRealTimers();
		localStorage.clear();
	});

	it('keeps drafts only in the current browser session, without reading old backups', () => {
		localStorage.setItem('chat_draft_chat-a', 'obsolete backup');
		const read = vi.spyOn(Storage.prototype, 'getItem');
		const write = vi.spyOn(Storage.prototype, 'setItem');
		const drafts = new ChatDraftStore();
		expect(drafts.view('chat-a').text).toBe('');
		drafts.setText('chat-a', 'alpha');
		const attachment = new File(['image'], 'image.png', { type: 'image/png' });
		drafts.setAttachments('chat-a', [attachment]);
		drafts.setText('chat-b', 'beta');
		window.dispatchEvent(new Event('pagehide'));
		expect(drafts.view('chat-a')).toMatchObject({ text: 'alpha', attachments: [attachment] });
		expect(drafts.view('chat-b').text).toBe('beta');
		const nextSession = new ChatDraftStore();
		expect(nextSession.view('chat-a')).toMatchObject({ text: '', attachments: [] });
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it('keeps one reactive entry for every consumer of the same chat', () => {
		const drafts = new ChatDraftStore();
		drafts.load('chat-a');
		const first = drafts.view('chat-a');
		const second = drafts.view('chat-a');

		drafts.setText('chat-a', 'shared text');

		expect(first).toBe(second);
		expect(drafts.view('chat-a').text).toBe('shared text');
		expect(drafts.view('chat-a').revision).toBe(1);
	});

	it('appends against the latest text and preserves attachments', () => {
		const drafts = new ChatDraftStore();
		const attachment = new File(['image'], 'image.png', { type: 'image/png' });
		drafts.setText('chat-a', 'Existing');
		drafts.setAttachments('chat-a', [attachment]);

		expect(drafts.appendBlock('chat-a', 'Review block')).toBe('appended');
		expect(drafts.view('chat-a').text).toBe('Existing\n\nReview block');
		expect(drafts.view('chat-a').attachments).toEqual([attachment]);
	});

	it('skips duplicate suppression only when appending allows duplicates', () => {
		const drafts = new ChatDraftStore();
		drafts.appendBlock('chat-a', 'Review block');

		expect(drafts.appendBlock('chat-a', 'Review block')).toBe('duplicate');
		expect(drafts.appendBlock('chat-a', 'Review block', { allowDuplicate: true })).toBe('appended');
		expect(drafts.view('chat-a').text).toBe('Review block\n\nReview block');
	});

	it.each([
		{ initial: '', expected: 'Review block' },
		{ initial: 'Existing\n', expected: 'Existing\n\nReview block' },
		{ initial: 'Existing\n\n', expected: 'Existing\n\nReview block' },
	])('appends with the required separator after "$initial"', ({ initial, expected }) => {
		const drafts = new ChatDraftStore();
		drafts.setText('chat-a', initial);

		expect(drafts.appendBlock('chat-a', 'Review block')).toBe('appended');
		expect(drafts.view('chat-a').text).toBe(expected);
	});

	it('clears text and attachments atomically', () => {
		const drafts = new ChatDraftStore();
		drafts.setText('chat-a', 'pending');
		drafts.setAttachments('chat-a', [new File(['a'], 'a.png', { type: 'image/png' })]);

		const revision = drafts.clear('chat-a');

		expect(drafts.view('chat-a')).toMatchObject({ text: '', attachments: [], revision });
	});

	it('restores a rejected submission only while its cleared revision is current', () => {
		const drafts = new ChatDraftStore();
		drafts.setText('chat-a', 'submitted');
		const snapshot = drafts.snapshot('chat-a');
		const clearedRevision = drafts.clear('chat-a');

		expect(drafts.restoreIfRevision('chat-a', clearedRevision, snapshot)).toBe(true);
		expect(drafts.view('chat-a').text).toBe('submitted');

		const secondSnapshot = drafts.snapshot('chat-a');
		const secondClear = drafts.clear('chat-a');
		drafts.setText('chat-a', 'newer preview edit');

		expect(drafts.restoreIfRevision('chat-a', secondClear, secondSnapshot)).toBe(false);
		expect(drafts.view('chat-a').text).toBe('newer preview edit');
	});

	it('discards only the deleted chat and clears all entries on destruction', () => {
		const drafts = new ChatDraftStore();
		drafts.setText('chat-a', 'alpha');
		drafts.setText('chat-b', 'beta');
		drafts.discardChat('chat-a');
		expect(drafts.view('chat-a').text).toBe('');
		expect(drafts.view('chat-b').text).toBe('beta');
		drafts.destroy();
		expect(drafts.view('chat-b').text).toBe('');
	});
});
