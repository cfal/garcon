import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { Vim, getCM, CodeMirror, type CodeMirrorV } from '@replit/codemirror-vim';
import { CodeEditorController } from '../code-editor-controller.svelte.js';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';

const cleanups: (() => void)[] = [];

function activeVim(view: EditorView): CodeMirror & CodeMirrorV {
	const cm = getCM(view);
	if (!cm?.state.vim) throw new Error('Expected an initialized Vim adapter');
	return cm as CodeMirror & CodeMirrorV;
}
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function documentState() {
	const document = new FileDocumentState(
		{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.txt' },
		'file',
	);
	document.content = document.baseline = 'one\ntwo\nthree';
	return document;
}

async function editor(document = documentState()) {
	const session = new FileViewSession(document);
	const settings = {
		editorThemeId: 'standard-light' as const,
		wordWrap: false,
		showLineNumbers: true,
		fontSize: 13,
		vimMode: true,
	};
	const save = vi.fn();
	const controller = new CodeEditorController(session, settings, save);
	const host = window.document.createElement('div');
	window.document.body.append(host);
	controller.attach(host);
	const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
	cleanups.push(() => {
		controller.dispose();
		session.dispose();
		host.remove();
	});
	await vi.waitFor(() => {
		expect(controller.vim.error).toBeNull();
		expect(getCM(view)).not.toBeNull();
	});
	return { session, settings, controller, host, view, save, cm: activeVim(view) };
}

describe('File Vim mode', () => {
	it('routes normal and Ex history through the shared document without global overrides', async () => {
		const undo = CodeMirror.commands.undo;
		const redo = CodeMirror.commands.redo;
		const first = await editor();
		const second = await editor(first.session.document);
		Vim.handleKey(first.cm, 'x', 'user');
		expect(second.view.state.doc.toString()).toBe('ne\ntwo\nthree');
		Vim.handleKey(second.cm, 'x', 'user');
		expect(first.view.state.doc.toString()).toBe('e\ntwo\nthree');
		Vim.handleKey(first.cm, 'u', 'user');
		expect(second.view.state.doc.toString()).toBe('ne\ntwo\nthree');
		Vim.handleKey(second.cm, '<C-r>', 'user');
		expect(first.view.state.doc.toString()).toBe('e\ntwo\nthree');
		Vim.handleEx(first.cm, 'undo');
		expect(second.view.state.doc.toString()).toBe('ne\ntwo\nthree');
		Vim.handleEx(second.cm, 'redo');
		expect(first.view.state.doc.toString()).toBe('e\ntwo\nthree');
		expect(CodeMirror.commands.undo).toBe(undo);
		expect(CodeMirror.commands.redo).toBe(redo);
	});

	it('keeps history through opt-out and renderer transfer', async () => {
		const { cm, controller, view, settings, host } = await editor();
		Vim.handleKey(cm, 'x', 'user');
		settings.vimMode = false;
		controller.reconfigure();
		expect(getCM(view)).toBeNull();
		expect(controller.run('undo')).toBe(true);
		controller.detach();
		settings.vimMode = true;
		controller.attach(host);
		const nextView = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
		await vi.waitFor(() => expect(getCM(nextView)).not.toBeNull());
		Vim.handleEx(activeVim(nextView), 'redo');
		expect(nextView.state.doc.toString()).toBe('ne\ntwo\nthree');
	});

	it('cancels pending activation when immediately disabled', async () => {
		const { controller, settings, view } = await editor();
		settings.vimMode = false;
		controller.reconfigure();
		settings.vimMode = true;
		controller.reconfigure();
		settings.vimMode = false;
		controller.reconfigure();
		await Promise.resolve();
		expect(getCM(view)).toBeNull();
	});

	it.each(['dd', 'p', 'x', ':delete', ':put', ':s/one/changed/', ':undo', ':redo', 'setValue'])(
		'blocks %s while the document is guarded',
		async (command) => {
			const { session, controller, cm, view } = await editor();
			Vim.handleKey(cm, 'x', 'user');
			const before = view.state.doc.toString();
			session.refreshing = true;
			controller.reconfigure();
			if (command === 'setValue') cm.setValue('forbidden');
			else if (command.startsWith(':')) Vim.handleEx(cm, command.slice(1));
			else for (const key of command) Vim.handleKey(cm, key, 'user');
			expect(view.state.doc.toString()).toBe(before);
			expect(session.content).toBe(before);
		},
	);

	it('uses the current editor Save callback for :w', async () => {
		const first = await editor();
		const second = await editor();
		Vim.handleEx(first.cm, 'write');
		expect(first.save).toHaveBeenCalledOnce();
		expect(second.save).not.toHaveBeenCalled();
	});

	it('lets Vim own Escape and control keys but keeps Find inputs independent', async () => {
		const { controller, view, host } = await editor();
		const owns: boolean[] = [];
		host.addEventListener('keydown', (event) => owns.push(controller.vim.ownsKey(event)), true);
		view.contentDOM.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }),
		);
		view.contentDOM.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }),
		);
		view.contentDOM.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'O',
				code: 'KeyO',
				ctrlKey: true,
				shiftKey: true,
				bubbles: true,
			}),
		);
		controller.run('find');
		host
			.querySelector<HTMLInputElement>('input[name="search"]')!
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }));
		expect(owns).toEqual([true, true, false, false]);
	});

	it('preserves control-key ownership across modifiers and Vim modes', async () => {
		const { controller, view, host, cm } = await editor();
		let owned = false;
		host.addEventListener(
			'keydown',
			(event) => {
				owned = controller.vim.ownsKey(event);
				event.stopImmediatePropagation();
			},
			true,
		);
		const owns = (key: string, modifiers: KeyboardEventInit = {}) => {
			view.contentDOM.dispatchEvent(
				new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, ...modifiers }),
			);
			return owned;
		};
		for (const key of ['b', 'd', 'e', 'r', 'u', 'y', 'o', 'i', 'w', 'v', 'c', '[', ']', 'n']) {
			expect(owns(key)).toBe(true);
			expect(owns(key.toUpperCase())).toBe(true);
			for (const modifiers of [
				{ ctrlKey: false },
				{ shiftKey: true },
				{ altKey: true },
				{ metaKey: true },
			]) {
				expect(owns(key, modifiers)).toBe(false);
			}
		}
		for (const key of ['', 'br', 'f', 'p', 'ArrowDown']) expect(owns(key)).toBe(false);
		Vim.handleKey(cm, 'v', 'user');
		expect(owns('n')).toBe(true);
		Vim.handleKey(cm, '<Esc>', 'user');
		Vim.handleKey(cm, 'i', 'user');
		expect(owns('n')).toBe(false);
		expect(owns('r')).toBe(true);
		expect(owns('Escape', { ctrlKey: false, shiftKey: true })).toBe(true);
	});

	it('dismisses Vim command input before opening Garcon Find', async () => {
		const { cm, controller, host } = await editor();
		Vim.handleKey(cm, ':', 'user');
		expect(host.querySelector('.cm-vim-panel input')).not.toBeNull();
		controller.run('find');
		expect(host.querySelector('.cm-vim-panel input')).toBeNull();
		expect(window.document.activeElement?.getAttribute('name')).toBe('search');
	});
});
