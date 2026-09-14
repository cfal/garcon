import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FileVimMode } from '../file-vim-mode.svelte.js';

vi.mock('@replit/codemirror-vim', () => {
	throw new Error('chunk unavailable');
});

afterEach(() => vi.restoreAllMocks());

describe('File Vim load failure', () => {
	it('retains the error through reconfiguration and renderer transfer until disabled', async () => {
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
			vim.configure(true);
			await vi.waitFor(() => expect(vim.error).toBe(error));
		} finally {
			view.destroy();
		}
	});
});
