import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Vim, getCM, type CodeMirror, type CodeMirrorV } from '@replit/codemirror-vim';
import { FileVimMode } from '../file-vim-mode.svelte.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	Vim.resetVimGlobalState_();
});

async function editor(readOnly = false) {
	const host = document.createElement('div');
	document.body.append(host);
	let view: EditorView | null = null;
	const vim = new FileVimMode({
		getView: () => view,
		undo: () => false,
		redo: () => false,
		save: () => undefined,
	});
	view = new EditorView({
		parent: host,
		state: EditorState.create({
			doc: 'one\ntwo\nthree',
			extensions: [
				vim.compartment.of([]),
				EditorState.readOnly.of(readOnly),
				EditorState.allowMultipleSelections.of(true),
			],
		}),
	});
	const activeView = view;
	cleanups.push(() => {
		view?.destroy();
		view = null;
		host.remove();
	});
	vim.configure(true);
	await vi.waitFor(() => expect(getCM(activeView)?.state.vim).toBeTruthy());
	const cm = getCM(activeView) as CodeMirror & CodeMirrorV;
	const keys = (...input: string[]) => {
		for (const key of input) Vim.handleKey(cm, key, 'user');
	};
	const transfer = () => {
		const retained = view!.state;
		view!.destroy();
		view = new EditorView({ parent: host, state: retained });
		vim.configure(true);
		return view;
	};
	return { view: activeView, cm, vim, keys, transfer };
}

function legacyCopy(result: boolean) {
	const descriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
	const copy = vi.fn(() => result);
	Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
	cleanups.push(() => {
		if (descriptor) Object.defineProperty(document, 'execCommand', descriptor);
		else Reflect.deleteProperty(document, 'execCommand');
	});
	return copy;
}

describe('Vim clipboard yanks', () => {
	it.each([
		{ keys: ['y', 'y'], text: 'one\n' },
		{ keys: ['2', 'y', 'y'], text: 'one\ntwo\n' },
		{ keys: ['Y'], text: 'one\n' },
		{ keys: ['G', 'y', 'y'], text: 'three\n' },
		{ keys: ['y', 'w'], text: 'one' },
		{ keys: ['v', 'l', 'y'], text: 'on' },
		{ keys: ['V', '2', 'G', 'y'], text: 'one\ntwo\n' },
		{ keys: ['<C-v>', '2', 'G', 'l', 'y'], text: 'on\ntw' },
		{ keys: ['"', '+', 'y', 'y'], text: 'one\n' },
		{ keys: ['"', 'a', 'y', 'y'], text: 'one\n' },
	])('copies $keys without changing the buffer', async ({ keys, text }) => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const current = await editor(true);
		current.keys(...keys);
		expect(write).toHaveBeenCalledExactlyOnceWith(text);
		expect(current.view.state.doc.toString()).toBe('one\ntwo\nthree');
		expect(Vim.getRegisterController().getRegister('"').toString()).toBe(text);
	});

	it('copies Ex ranges and repeated yanks of identical text', async () => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const { cm } = await editor();
		Vim.handleEx(cm, '1,2yank');
		Vim.handleEx(cm, '1,2yank');
		expect(write.mock.calls).toEqual([['one\ntwo\n'], ['one\ntwo\n']]);
	});

	it('preserves named append registers and internal paste', async () => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const { keys, view, cm } = await editor();
		keys('"', 'a', 'y', 'y');
		cm.setCursor(1, 0);
		keys('"', 'A', 'y', 'y');
		expect(Vim.getRegisterController().getRegister('a').toString()).toBe('one\ntwo\n');
		expect(write).toHaveBeenLastCalledWith('one\ntwo\n');
		cm.setCursor(1, 0);
		keys('"', 'a', 'p');
		expect(view.state.doc.toString()).toBe('one\ntwo\none\ntwo\nthree');
		expect(write).toHaveBeenCalledTimes(2);
	});

	it('does not copy deletes, movement, or black-hole yanks', async () => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const { keys } = await editor();
		keys('"', '_', 'y', 'y', 'j', 'x', 'd', 'd');
		expect(write).not.toHaveBeenCalled();
	});

	it('leaves cancelled and black-hole Ex yanks off the clipboard', async () => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const { keys, cm } = await editor();
		keys('y', '<Esc>');
		Vim.handleEx(cm, 'yank _');
		expect(write).not.toHaveBeenCalled();
		expect(Vim.getRegisterController().getRegister('"').toString()).toBe('');
	});

	it.each(['d', 'c'])('retains explicit clipboard-register %s behavior', async (operator) => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const { keys } = await editor();
		keys('"', '+', operator, operator);
		expect(write).toHaveBeenCalledExactlyOnceWith('one\n');
	});

	it('retains the yank and reports failure until the next successful copy', async () => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
		legacyCopy(false);
		const { keys, vim, view, cm } = await editor();
		keys('y', 'y');
		await vi.waitFor(() => expect(vim.clipboardFailed).toBe(true));
		expect(vim.error).toBeNull();
		cm.setCursor(0, 0);
		keys('p');
		expect(view.state.doc.toString()).toBe('one\none\ntwo\nthree');
		write.mockResolvedValue();
		keys('y', 'y');
		await vi.waitFor(() => expect(vim.clipboardFailed).toBe(false));
	});

	it('does not report a stale copy failure after Vim is disabled', async () => {
		const pending = Promise.withResolvers<void>();
		vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(pending.promise);
		const copy = legacyCopy(false);
		const { keys, vim } = await editor();
		keys('y', 'y');
		vim.configure(false);
		pending.reject(new Error('Late failure'));
		await pending.promise.catch(() => undefined);
		expect(copy).not.toHaveBeenCalled();
		expect(vim.clipboardFailed).toBe(false);
	});

	it.each([false, true])(
		'does not let a stale fallback overwrite a newer yank (other view: %s)',
		async (otherView) => {
			const pending = Promise.withResolvers<void>();
			const write = vi
				.spyOn(navigator.clipboard, 'writeText')
				.mockReturnValueOnce(pending.promise)
				.mockResolvedValue();
			const copy = legacyCopy(false);
			const first = await editor();
			const second = otherView ? await editor() : first;
			first.keys('y', 'y');
			second.cm.setCursor(1, 0);
			second.keys('y', 'y');
			expect(write.mock.calls).toEqual([['one\n'], ['two\n']]);
			pending.reject(new Error('Older copy denied'));
			await pending.promise.catch(() => undefined);
			expect(copy).not.toHaveBeenCalled();
			expect(first.vim.clipboardFailed).toBe(false);
			expect(second.vim.clipboardFailed).toBe(false);
		},
	);

	it('ignores empty yanks without claiming clipboard failure', async () => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const copy = legacyCopy(false);
		const { keys, vim } = await editor();
		keys('y', '0');
		await Promise.resolve();
		await Promise.resolve();
		expect(write).not.toHaveBeenCalled();
		expect(copy).not.toHaveBeenCalled();
		expect(vim.clipboardFailed).toBe(false);
	});

	it('uses the current view after transfer and re-enabling Vim without duplicate handlers', async () => {
		vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined!);
		const copy = legacyCopy(true);
		const first = await editor();
		const second = await editor();
		const transferred = first.transfer();
		const cm = getCM(transferred) as CodeMirror & CodeMirrorV;
		copy.mockImplementation(() => {
			expect(transferred.dom.contains(document.activeElement)).toBe(true);
			return true;
		});
		Vim.handleEx(cm, 'yank +');
		expect(copy).toHaveBeenCalledTimes(1);
		first.vim.configure(false);
		first.vim.configure(true);
		await vi.waitFor(() => expect(getCM(transferred)).not.toBeNull());
		Vim.handleEx(getCM(transferred) as CodeMirror & CodeMirrorV, 'yank');
		expect(copy).toHaveBeenCalledTimes(2);
		expect(second.vim.clipboardFailed).toBe(false);
	});

	it.each(['missing', 'denied'])(
		'uses the legacy fallback when clipboard access is %s',
		async (mode) => {
			if (mode === 'missing') vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined!);
			else vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
			const copy = legacyCopy(true);
			const { keys, view } = await editor();
			view.focus();
			copy.mockImplementation(() => {
				const textarea = document.activeElement as HTMLTextAreaElement;
				expect(textarea.value).toBe('one\n');
				expect(view.dom.contains(textarea)).toBe(true);
				return true;
			});
			keys('"', '+', 'y', 'y');
			await vi.waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith('copy'));
			expect(view.hasFocus).toBe(true);
			expect(view.dom.querySelector('textarea')).toBeNull();
		},
	);
});
