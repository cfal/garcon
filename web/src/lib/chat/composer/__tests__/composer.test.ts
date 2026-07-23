// Unit tests for ComposerState class. Tests synchronous state management;
// submitMessage and localStorage-dependent draft methods are not tested here.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { ComposerState } from '../composer.svelte';
import { chatDraftStorageKey } from '$lib/utils/local-persistence';

describe('ComposerState', () => {
	afterEach(() => {
		vi.useRealTimers();
		localStorage.clear();
	});

	it('starts with empty state', () => {
		const state = new ComposerState();
		expect(state.inputText).toBe('');
		expect(state.images).toEqual([]);
		expect(state.isSubmitting).toBe(false);
		expect(state.isDragActive).toBe(false);
	});

	it('addImages appends supported non-duplicate attachments', () => {
		const state = new ComposerState();
		const file1 = new File(['a'], 'a.png', { type: 'image/png' });
		const file2 = new File(['b'], 'notes.md', { type: 'text/markdown' });
		const file1dup = new File(['c'], 'a.png', { type: 'image/png' });
		const unsupported = new File(['d'], 'archive.zip', { type: 'application/zip' });

		state.addImages([file1]);
		expect(state.images).toHaveLength(1);

		state.addImages([file2, file1dup, unsupported]);
		expect(state.images).toHaveLength(2);
		expect(state.images.map((f) => f.name)).toEqual(['a.png', 'notes.md']);
	});

	it('removeImage removes at index', () => {
		const state = new ComposerState();
		state.addImages([
			new File(['a'], 'a.png', { type: 'image/png' }),
			new File(['b'], 'b.png', { type: 'image/png' }),
		]);

		state.removeImage(0);
		expect(state.images).toHaveLength(1);
		expect(state.images[0].name).toBe('b.png');
	});

	it('clearImages empties the array', () => {
		const state = new ComposerState();
		state.addImages([new File(['a'], 'a.png', { type: 'image/png' })]);
		state.clearImages();
		expect(state.images).toEqual([]);
	});

	it('clearAfterSubmit resets input and images', () => {
		const state = new ComposerState();
		state.inputText = 'hello';
		state.addImages([new File(['a'], 'a.png', { type: 'image/png' })]);

		state.clearAfterSubmit('test-chat-id');

		expect(state.inputText).toBe('');
		expect(state.images).toEqual([]);
	});

	it('debounces draft writes and persists the latest queued text', () => {
		vi.useFakeTimers();
		const composer = new ComposerState();
		composer.inputText = 'first';
		composer.queueDraftSave('chat-1', composer.inputText);
		composer.inputText = 'second';
		composer.queueDraftSave('chat-1', composer.inputText);

		expect(localStorage.getItem(chatDraftStorageKey('chat-1'))).toBeNull();
		vi.advanceTimersByTime(250);

		expect(localStorage.getItem(chatDraftStorageKey('chat-1'))).toBe('second');
	});

	it('does not let an old chat draft save after restore changes the input', () => {
		vi.useFakeTimers();
		const composer = new ComposerState();
		composer.inputText = 'old chat text';
		composer.queueDraftSave('old-chat', composer.inputText);

		composer.restoreDraft('new-chat');
		composer.inputText = 'new chat text';
		vi.runAllTimers();

		expect(localStorage.getItem(chatDraftStorageKey('old-chat'))).toBeNull();
	});

	it('flushes a pending draft immediately', () => {
		vi.useFakeTimers();
		const composer = new ComposerState();
		composer.inputText = 'draft body';
		composer.queueDraftSave('chat-2', composer.inputText);

		composer.flushDraftSave();

		expect(localStorage.getItem(chatDraftStorageKey('chat-2'))).toBe('draft body');
	});

	it('retains attachment drafts independently for each chat', () => {
		const composer = new ComposerState();
		const alphaImage = new File(['alpha'], 'alpha.png', { type: 'image/png' });
		const betaImage = new File(['beta'], 'beta.png', { type: 'image/png' });

		composer.inputText = 'alpha draft';
		composer.addImages([alphaImage]);
		composer.saveDraft('alpha');
		composer.restoreDraft('beta');
		expect(composer.images).toEqual([]);

		composer.inputText = 'beta draft';
		composer.addImages([betaImage]);
		composer.saveDraft('beta');
		composer.restoreDraft('alpha');

		expect(composer.inputText).toBe('alpha draft');
		expect(composer.images).toEqual([alphaImage]);
		composer.restoreDraft('beta');
		expect(composer.images).toEqual([betaImage]);

		composer.clearAfterSubmit('beta');
		composer.restoreDraft('beta');
		expect(composer.images).toEqual([]);
	});

	it('appends an editable block and persists it immediately without changing attachments', () => {
		const composer = new ComposerState();
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
		const composer = new ComposerState();
		expect(composer.appendDraftBlock('chat-1', 'Review block')).toBe('appended');
		expect(composer.appendDraftBlock('chat-1', 'Review block')).toBe('duplicate');
		expect(composer.draftAppendRequest?.requestId).toBe(1);

		composer.inputText = 'Edited review block';

		expect(composer.appendDraftBlock('chat-1', 'Review block')).toBe('appended');
		expect(composer.draftAppendRequest?.requestId).toBe(2);
	});

	it('reports unavailable when no chat is active', () => {
		const composer = new ComposerState();
		expect(composer.appendDraftBlock('', 'Review block')).toBe('unavailable');
		expect(composer.inputText).toBe('');
	});
});
