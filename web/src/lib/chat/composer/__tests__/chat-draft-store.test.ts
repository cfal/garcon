import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatDraftStore } from '../chat-draft-store.svelte.js';
import { chatDraftStorageKey } from '$lib/utils/local-persistence';

describe('ChatDraftStore', () => {
	afterEach(() => {
		vi.useRealTimers();
		localStorage.clear();
	});

	it('coalesces persistence without dropping dirty drafts from another chat', () => {
		vi.useFakeTimers();
		const drafts = new ChatDraftStore();
		drafts.setText('chat-a', 'alpha');
		drafts.queuePersist('chat-a', 'alpha');
		drafts.setText('chat-b', 'beta');
		drafts.queuePersist('chat-b', 'beta');

		vi.advanceTimersByTime(250);

		expect(localStorage.getItem(chatDraftStorageKey('chat-a'))).toBe('alpha');
		expect(localStorage.getItem(chatDraftStorageKey('chat-b'))).toBe('beta');
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
		expect(localStorage.getItem(chatDraftStorageKey('chat-a'))).toBe('Existing\n\nReview block');
	});

	it('clears text, attachments, pending persistence, and stored text atomically', () => {
		vi.useFakeTimers();
		const drafts = new ChatDraftStore();
		drafts.setText('chat-a', 'pending');
		drafts.setAttachments('chat-a', [new File(['a'], 'a.png', { type: 'image/png' })]);
		drafts.queuePersist('chat-a', 'pending');

		const revision = drafts.clear('chat-a');
		vi.runAllTimers();

		expect(drafts.view('chat-a')).toMatchObject({ text: '', attachments: [], revision });
		expect(localStorage.getItem(chatDraftStorageKey('chat-a'))).toBeNull();
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
		drafts.setTextAndFlush('chat-a', 'newer preview edit');

		expect(drafts.restoreIfRevision('chat-a', secondClear, secondSnapshot)).toBe(false);
		expect(drafts.view('chat-a').text).toBe('newer preview edit');
	});

	it('keeps memory authoritative after the first load and discards only on chat deletion', () => {
		localStorage.setItem(chatDraftStorageKey('chat-a'), 'stored');
		const drafts = new ChatDraftStore();
		drafts.load('chat-a');
		localStorage.setItem(chatDraftStorageKey('chat-a'), 'stale external value');
		drafts.load('chat-a');

		expect(drafts.view('chat-a').text).toBe('stored');
		drafts.discardChat('chat-a');
		expect(drafts.view('chat-a').text).toBe('');
		expect(localStorage.getItem(chatDraftStorageKey('chat-a'))).toBeNull();
	});

	it('flushes every dirty chat on pagehide', () => {
		vi.useFakeTimers();
		const drafts = new ChatDraftStore();
		const unmount = drafts.mountPersistenceLifecycle();
		drafts.setText('chat-a', 'alpha');
		drafts.queuePersist('chat-a', 'alpha');
		drafts.setText('chat-b', 'beta');
		drafts.queuePersist('chat-b', 'beta');

		window.dispatchEvent(new Event('pagehide'));

		expect(localStorage.getItem(chatDraftStorageKey('chat-a'))).toBe('alpha');
		expect(localStorage.getItem(chatDraftStorageKey('chat-b'))).toBe('beta');
		unmount();
	});
});
