import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { PromptEditorController } from '../prompt-editor-controller.js';
import type { WorkspaceLocalShortcutOwner } from '$lib/workspace/workspace-shortcuts.js';

const mounted: HTMLElement[] = [];

afterEach(() => {
	for (const element of mounted) element.remove();
	mounted.length = 0;
});

function parent(): HTMLDivElement {
	const element = document.createElement('div');
	document.body.append(element);
	mounted.push(element);
	return element;
}

describe('PromptEditorController', () => {
	it('synchronizes user and external documents without echoing external changes', async () => {
		const localOwners: WorkspaceLocalShortcutOwner[] = [];
		const unregisterLocalOwner = vi.fn();
		const onTextChange = vi.fn();
		const onSelectionChange = vi.fn();
		const host = parent();
		const controller = new PromptEditorController(host, {
			initialText: 'first\nsecond',
			initialSelection: { anchor: 8, head: 2 },
			ariaLabel: 'Expanded composer text',
			workspaceShortcuts: {
				matchesGlobalShortcut: () => false,
				registerLocalShortcutOwner: (_element, owner) => {
					localOwners.push(owner);
					return unregisterLocalOwner;
				},
			},
			onTextChange,
			onSelectionChange,
		});
		const editor = host.querySelector<HTMLElement>('.cm-editor');
		if (!editor) throw new Error('Expected a CodeMirror editor');
		const view = EditorView.findFromDOM(editor);
		if (!view) throw new Error('Expected the CodeMirror view');

		expect(view.state.selection.main.anchor).toBe(8);
		expect(view.state.selection.main.head).toBe(2);
		expect(view.scrollDOM.dataset.workspaceScrollRegion).toBe('primary');
		const localOwner = localOwners[0];
		if (!localOwner) throw new Error('Expected a local shortcut owner');
		expect(localOwner(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }))).toBe(true);
		expect(localOwner(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }))).toBe(false);

		view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } });
		expect(onTextChange).toHaveBeenCalledWith('first\nsecond!');
		controller.syncText('external');
		expect(view.state.doc.toString()).toBe('external');
		expect(onTextChange).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect(onSelectionChange).toHaveBeenCalledWith({ anchor: 8, head: 2 });

		controller.destroy();
		expect(unregisterLocalOwner).toHaveBeenCalledOnce();
		expect(view.scrollDOM.dataset.workspaceScrollRegion).toBeUndefined();
	});

	it('gives curated Control movement and deletion precedence over default bindings', () => {
		const host = parent();
		const controller = new PromptEditorController(host, {
			initialText: 'one\ntwo\nthree',
			initialSelection: { anchor: 6, head: 6 },
			ariaLabel: 'Expanded composer text',
			workspaceShortcuts: {
				matchesGlobalShortcut: (id, event) =>
					id === 'scroll-half-page-down' && event.ctrlKey && event.key.toLowerCase() === 'd',
				registerLocalShortcutOwner: () => () => undefined,
			},
			onTextChange: () => undefined,
			onSelectionChange: () => undefined,
		});
		const content = host.querySelector<HTMLElement>('.cm-content');
		if (!content) throw new Error('Expected CodeMirror content');
		const view = EditorView.findFromDOM(content);
		if (!view) throw new Error('Expected the CodeMirror view');

		const lineStart = new KeyboardEvent('keydown', {
			key: 'a',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		content.dispatchEvent(lineStart);
		expect(lineStart.defaultPrevented).toBe(true);
		expect(view.state.selection.main.anchor).toBe(4);
		expect(view.state.selection.main.empty).toBe(true);

		const selectLineEnd = new KeyboardEvent('keydown', {
			key: 'E',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(selectLineEnd, 'keyCode', { value: 69 });
		content.dispatchEvent(selectLineEnd);
		expect(selectLineEnd.defaultPrevented).toBe(true);
		expect(view.state.selection.main.anchor).toBe(4);
		expect(view.state.selection.main.head).toBe(7);

		content.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'k',
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(view.state.doc.toString()).toBe('one\n\nthree');

		controller.syncText('one\ntwo\nthree');
		view.dispatch({ selection: { anchor: 5 } });
		content.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'k',
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(view.state.doc.toString()).toBe('one\nt\nthree');

		controller.syncText('one\ntwo\nthree');
		const unapprovedDeleteLine = new KeyboardEvent('keydown', {
			key: 'K',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(unapprovedDeleteLine, 'keyCode', { value: 75 });
		content.dispatchEvent(unapprovedDeleteLine);
		expect(view.state.doc.toString()).toBe('one\ntwo\nthree');

		const halfPageDown = new KeyboardEvent('keydown', {
			key: 'd',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		content.dispatchEvent(halfPageDown);
		expect(halfPageDown.defaultPrevented).toBe(true);
		controller.destroy();
	});

	it('leaves disabled half-page shortcuts unclaimed', () => {
		const host = parent();
		const controller = new PromptEditorController(host, {
			initialText: 'one\ntwo',
			initialSelection: { anchor: 0, head: 0 },
			ariaLabel: 'Expanded prompt text',
			workspaceShortcuts: {
				matchesGlobalShortcut: () => false,
				registerLocalShortcutOwner: () => () => undefined,
			},
			onTextChange: () => undefined,
			onSelectionChange: () => undefined,
		});
		const content = host.querySelector<HTMLElement>('.cm-content');
		if (!content) throw new Error('Expected CodeMirror content');

		const halfPageDown = new KeyboardEvent('keydown', {
			key: 'd',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		content.dispatchEvent(halfPageDown);
		expect(halfPageDown.defaultPrevented).toBe(false);
		controller.destroy();
	});

	it('reconfigures read-only mode without remounting or moving the selection', () => {
		const host = parent();
		const controller = new PromptEditorController(host, {
			initialText: 'one\ntwo',
			initialSelection: { anchor: 5, head: 5 },
			ariaLabel: 'Expanded composer text',
			workspaceShortcuts: {
				matchesGlobalShortcut: () => false,
				registerLocalShortcutOwner: () => () => undefined,
			},
			onTextChange: () => undefined,
			onSelectionChange: () => undefined,
		});
		const editor = host.querySelector<HTMLElement>('.cm-editor');
		const content = host.querySelector<HTMLElement>('.cm-content');
		if (!editor || !content) throw new Error('Expected CodeMirror elements');
		const view = EditorView.findFromDOM(editor);
		if (!view) throw new Error('Expected the CodeMirror view');
		view.scrollDOM.scrollTop = 24;

		controller.setReadOnly(true);
		expect(host.querySelector('.cm-editor')).toBe(editor);
		expect(view.state.readOnly).toBe(true);
		expect(content.getAttribute('contenteditable')).toBe('false');
		expect(content.getAttribute('aria-readonly')).toBe('true');
		expect(view.state.selection.main.anchor).toBe(5);
		expect(view.scrollDOM.scrollTop).toBe(24);

		content.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'k',
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(view.state.doc.toString()).toBe('one\ntwo');

		controller.setReadOnly(false);
		expect(view.state.readOnly).toBe(false);
		expect(content.getAttribute('contenteditable')).toBe('true');
		controller.destroy();
	});
});
