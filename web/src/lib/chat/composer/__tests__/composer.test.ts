// Unit tests for ComposerState class. Tests synchronous state management;
// submitMessage and localStorage-dependent draft methods are not tested here.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { ComposerState } from '../composer.svelte';
import { ChatDraftStore } from '../chat-draft-store.svelte.js';
import { chatDraftStorageKey } from '$lib/utils/local-persistence';

function createComposer(initialChatId: string | null = 'chat-1') {
	let activeChatId = initialChatId;
	const drafts = new ChatDraftStore();
	const composer = new ComposerState(drafts, {
		get activeChatId() {
			return activeChatId;
		},
	});
	if (activeChatId) composer.restoreDraft(activeChatId);
	return {
		composer,
		drafts,
		selectChat(chatId: string | null) {
			activeChatId = chatId;
			if (chatId) composer.restoreDraft(chatId);
		},
	};
}

describe('ComposerState', () => {
	afterEach(() => {
		vi.useRealTimers();
		localStorage.clear();
	});

	it('starts with empty state', () => {
		const { composer: state } = createComposer();
		expect(state.inputText).toBe('');
		expect(state.images).toEqual([]);
		expect(state.isSubmitting).toBe(false);
		expect(state.isDragActive).toBe(false);
	});

	it('addImages appends supported non-duplicate attachments', () => {
		const { composer: state } = createComposer();
		const file1 = new File(['a'], 'a.png', { type: 'image/png' });
		const file2 = new File(['b'], 'notes.md', { type: 'text/markdown' });
		const file1dup = new File(['c'], 'a.png', { type: 'image/png' });
		const unsupported = new File(['d'], 'archive.zip', { type: 'application/zip' });

		state.addImages([file1]);
		expect(state.images).toHaveLength(1);

		state.addImages([file2, file1dup, file1, unsupported]);
		expect(state.images).toHaveLength(3);
		expect(state.images.map((f) => f.name)).toEqual(['a.png', 'notes.md', 'a.png']);
	});

	it('removeImage removes at index', () => {
		const { composer: state } = createComposer();
		state.addImages([
			new File(['a'], 'a.png', { type: 'image/png' }),
			new File(['b'], 'b.png', { type: 'image/png' }),
		]);

		state.removeImage(0);
		expect(state.images).toHaveLength(1);
		expect(state.images[0].name).toBe('b.png');
	});

	it('clearImages empties the array', () => {
		const { composer: state } = createComposer();
		state.addImages([new File(['a'], 'a.png', { type: 'image/png' })]);
		state.clearImages();
		expect(state.images).toEqual([]);
	});

	it('clearAfterSubmit resets input and images', () => {
		const { composer: state } = createComposer();
		state.inputText = 'hello';
		state.addImages([new File(['a'], 'a.png', { type: 'image/png' })]);

		state.clearAfterSubmit('chat-1');

		expect(state.inputText).toBe('');
		expect(state.images).toEqual([]);
	});

	it('advances the content revision for every text and attachment assignment', () => {
		const { composer: state } = createComposer();
		const initialRevision = state.contentRevision;

		state.inputText = '';
		expect(state.contentRevision).toBe(initialRevision + 1);
		state.images = [];
		expect(state.contentRevision).toBe(initialRevision + 2);
		state.clearAfterSubmit('chat-1');
		expect(state.contentRevision).toBe(initialRevision + 3);
	});

	it('debounces draft writes and persists the latest queued text', () => {
		vi.useFakeTimers();
		const { composer } = createComposer('chat-1');
		composer.inputText = 'first';
		composer.queueDraftSave('chat-1', composer.inputText);
		composer.inputText = 'second';
		composer.queueDraftSave('chat-1', composer.inputText);

		expect(localStorage.getItem(chatDraftStorageKey('chat-1'))).toBeNull();
		vi.advanceTimersByTime(250);

		expect(localStorage.getItem(chatDraftStorageKey('chat-1'))).toBe('second');
	});

	it('does not drop an old chat draft when another chat becomes active', () => {
		vi.useFakeTimers();
		const { composer, selectChat } = createComposer('old-chat');
		composer.inputText = 'old chat text';
		composer.queueDraftSave('old-chat', composer.inputText);

		selectChat('new-chat');
		composer.inputText = 'new chat text';
		vi.runAllTimers();

		expect(localStorage.getItem(chatDraftStorageKey('old-chat'))).toBe('old chat text');
		expect(composer.inputText).toBe('new chat text');
	});

	it('flushes a pending draft immediately', () => {
		vi.useFakeTimers();
		const { composer, drafts } = createComposer('chat-2');
		composer.inputText = 'draft body';
		composer.queueDraftSave('chat-2', composer.inputText);

		drafts.flushAll();

		expect(localStorage.getItem(chatDraftStorageKey('chat-2'))).toBe('draft body');
	});

	it('retains attachment drafts independently for each chat', () => {
		const { composer, selectChat } = createComposer('alpha');
		const alphaImage = new File(['alpha'], 'alpha.png', { type: 'image/png' });
		const betaImage = new File(['beta'], 'beta.png', { type: 'image/png' });

		composer.inputText = 'alpha draft';
		composer.addImages([alphaImage]);
		composer.saveDraft('alpha');
		selectChat('beta');
		expect(composer.images).toEqual([]);

		composer.inputText = 'beta draft';
		composer.addImages([betaImage]);
		composer.saveDraft('beta');
		selectChat('alpha');

		expect(composer.inputText).toBe('alpha draft');
		expect(composer.images).toEqual([alphaImage]);
		selectChat('beta');
		expect(composer.images).toEqual([betaImage]);

		composer.clearAfterSubmit('beta');
		selectChat('beta');
		expect(composer.images).toEqual([]);
	});

	it('appends an editable block and persists it immediately without changing attachments', () => {
		const { composer } = createComposer('chat-1');
		const image = new File(['a'], 'a.png', { type: 'image/png' });
		composer.inputText = 'Existing draft\n';
		composer.addImages([image]);

		const result = composer.appendDraftBlock('chat-1', 'Git review comment');

		expect(result).toBe('appended');
		expect(composer.inputText).toBe('Existing draft\n\nGit review comment');
		expect(composer.images).toEqual([image]);
		expect(composer.draftAppendRequest).toEqual({ chatId: 'chat-1', requestId: 1 });
		expect(localStorage.getItem(chatDraftStorageKey('chat-1'))).toBe(composer.inputText);
	});

	it('does not duplicate an unchanged block and allows an edited block to be appended again', () => {
		const { composer } = createComposer('chat-1');
		expect(composer.appendDraftBlock('chat-1', 'Review block')).toBe('appended');
		expect(composer.appendDraftBlock('chat-1', 'Review block')).toBe('duplicate');
		expect(composer.draftAppendRequest?.requestId).toBe(1);

		composer.inputText = 'Edited review block';

		expect(composer.appendDraftBlock('chat-1', 'Review block')).toBe('appended');
		expect(composer.draftAppendRequest?.requestId).toBe(2);
	});

	it('reports unavailable when no chat is active', () => {
		const { composer } = createComposer(null);
		expect(composer.appendDraftBlock('', 'Review block')).toBe('unavailable');
		expect(composer.inputText).toBe('');
	});
});
