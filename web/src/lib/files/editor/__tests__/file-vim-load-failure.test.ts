import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FileVimMode } from '../file-vim-mode.svelte.js';

afterEach(() => vi.doUnmock('@replit/codemirror-vim'));

describe('File Vim load failure', () => {
	it('retains the error until disabled, then retries a transient import failure', async () => {
		vi.doMock('@replit/codemirror-vim', () => {
			throw new Error('chunk unavailable');
		});
		let view: EditorView;
		const vim = new FileVimMode({
			getView: () => view,
			undo: () => false,
			redo: () => false,
			save: () => undefined,
		});
		const createView = () =>
			new EditorView({ state: EditorState.create({ extensions: [vim.compartment.of([])] }) });
		view = createView();
		try {
			vim.configure(true);
			await vi.waitFor(() => expect(vim.error).toContain('Vim mode could not load'));
			const error = vim.error;
			vim.configure(true);
			expect(vim.error).toBe(error);
			view.destroy();
			view = createView();
			vim.configure(true);
			expect(vim.error).toBe(error);
			vim.configure(false);
			expect(vim.error).toBeNull();
			vi.doUnmock('@replit/codemirror-vim');
			vim.configure(true);
			const { getCM } = await import('@replit/codemirror-vim');
			await vi.waitFor(() => expect(getCM(view)).toBeTruthy());
			expect(vim.error).toBeNull();
		} finally {
			view.destroy();
		}
	});
});
