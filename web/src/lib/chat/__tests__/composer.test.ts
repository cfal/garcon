// Unit tests for ComposerState class. Tests synchronous state management;
// submitMessage and localStorage-dependent draft methods are not tested here.

import { describe, it, expect } from 'vitest';
import { ComposerState } from '../composer.svelte';

describe('ComposerState', () => {
	it('starts with empty state', () => {
		const state = new ComposerState();
		expect(state.inputText).toBe('');
		expect(state.images).toEqual([]);
		expect(state.isSubmitting).toBe(false);
		expect(state.isDragActive).toBe(false);
	});

	it('addImages appends non-duplicate files', () => {
		const state = new ComposerState();
		const file1 = new File(['a'], 'a.png', { type: 'image/png' });
		const file2 = new File(['b'], 'b.png', { type: 'image/png' });
		const file1dup = new File(['c'], 'a.png', { type: 'image/png' });

		state.addImages([file1]);
		expect(state.images).toHaveLength(1);

		state.addImages([file2, file1dup]);
		expect(state.images).toHaveLength(2);
		expect(state.images.map((f) => f.name)).toEqual(['a.png', 'b.png']);
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
});
