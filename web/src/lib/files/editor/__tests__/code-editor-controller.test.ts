import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history } from '@codemirror/commands';
import type { CanonicalFileIdentity } from '$shared/file-contracts';
import { FileSession } from '$lib/files/sessions/file-session.svelte.js';
import { CodeEditorController } from '$lib/files/editor/code-editor-controller.svelte.js';

const mounted: HTMLElement[] = [];

afterEach(() => {
	for (const element of mounted) element.remove();
	mounted.length = 0;
});

function parent(): HTMLDivElement {
	const element = document.createElement('div');
	element.style.width = '800px';
	element.style.height = '600px';
	document.body.append(element);
	mounted.push(element);
	return element;
}

function createController() {
	const identity: CanonicalFileIdentity = {
		canonicalFileRootPath: '/workspace',
		normalizedRelativePath: 'src/file.ts',
	};
	const session = new FileSession(identity, JSON.stringify(['/workspace', 'src/file.ts']));
	session.content = 'first\nsecond\nthird';
	session.baseline = session.content;
	session.editorState = EditorState.create({
		doc: session.content,
		selection: { anchor: 8 },
		extensions: [history()],
	});
	const settings = {
		get isDark() {
			return false;
		},
		get wordWrap() {
			return false;
		},
		get showLineNumbers() {
			return true;
		},
		get fontSize() {
			return 12;
		},
	};
	return { session, controller: new CodeEditorController(session, settings) };
}

describe('CodeEditorController', () => {
	it('moves one editor state between hosts and ignores stale cleanup', () => {
		const { session, controller } = createController();
		const firstParent = parent();
		const secondParent = parent();

		const firstLease = controller.attach(firstParent);
		const firstScroller = firstParent.querySelector<HTMLElement>('.cm-scroller');
		if (firstScroller) firstScroller.scrollTop = 24;
		controller.prepareRendererTransfer();
		const secondLease = controller.attach(secondParent);
		controller.detach(firstLease);

		expect(controller.isAttached).toBe(true);
		expect(firstParent.querySelector('.cm-editor')).toBeNull();
		expect(secondParent.querySelector('.cm-editor')).not.toBeNull();
		controller.detach(secondLease);
		expect(controller.isAttached).toBe(false);
		expect(session.editorState?.doc.toString()).toBe('first\nsecond\nthird');
		expect(session.editorState?.selection.main.anchor).toBe(8);
	});

	it('rejects overlapping renderer attachment', () => {
		const { controller } = createController();
		controller.attach(parent());

		expect(() => controller.attach(parent())).toThrow('already attached');
		controller.dispose();
	});

	it('compares editor documents without materializing content on every transaction', () => {
		const { session, controller } = createController();
		const host = parent();
		controller.attach(host);
		const content = host.querySelector<HTMLElement>('.cm-content');
		if (!content) throw new Error('Expected CodeMirror content');

		content.dispatchEvent(
			new InputEvent('beforeinput', {
				inputType: 'insertText',
				data: 'x',
				bubbles: true,
				cancelable: true,
			}),
		);

		// Direct dispatch behavior is covered by CodeMirror; the controller keeps
		// the stored string lazy until a save or renderer detach requests it.
		expect(session.content).toBe('first\nsecond\nthird');
		controller.detach();
		expect(session.content).toBe(session.editorState?.doc.toString());
	});

	it('applies the latest requested location without recreating session identity', async () => {
		const { session, controller } = createController();
		session.requestLocation(3, 2);
		const lease = controller.attach(parent());
		await new Promise((resolve) => requestAnimationFrame(resolve));

		expect(session.requestedLine).toBeNull();
		expect(session.requestedColumn).toBeNull();
		controller.detach(lease);
		const editorState = session.editorState;
		if (!editorState) throw new Error('Expected the editor state to survive detachment.');
		expect(editorState.selection.main.head).toBe(editorState.doc.line(3).from + 1);
	});

	it('normalizes CRLF for dirty comparison and preserves it when serializing', () => {
		const { session, controller } = createController();
		controller.replaceContentFromDisk('first\r\nsecond');
		const lease = controller.attach(parent());

		expect(session.dirty).toBe(false);
		expect(controller.currentContent()).toBe('first\r\nsecond');

		controller.detach(lease);
		session.editorState = EditorState.create({ doc: 'first\nsecond!' });
		const editedLease = controller.attach(parent());

		expect(session.dirty).toBe(true);
		expect(controller.currentContent()).toBe('first\r\nsecond!');
		controller.detach(editedLease);
	});

	it('replaces an attached disk document with fresh history and clamped selection', async () => {
		const { session, controller } = createController();
		const host = parent();
		const lease = controller.attach(host);
		const scroller = host.querySelector<HTMLElement>('.cm-scroller');
		if (!scroller) throw new Error('Expected CodeMirror scroller');
		scroller.scrollTop = 28;

		controller.replaceContentFromDisk('new');
		host.querySelector<HTMLElement>('.cm-content')?.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
		);
		await new Promise((resolve) => requestAnimationFrame(resolve));

		expect(controller.currentContent()).toBe('new');
		expect(session.baseline).toBe('new');
		expect(session.dirty).toBe(false);
		expect(session.editorState?.selection.main.anchor).toBe(3);
		expect(scroller.scrollTop).toBe(28);
		controller.detach(lease);
	});

	it('clamps replacement selection against the normalized CRLF document', () => {
		const { session, controller } = createController();
		const lease = controller.attach(parent());

		expect(() => controller.replaceContentFromDisk('a\r\nb\r\n')).not.toThrow();

		expect(controller.currentContent()).toBe('a\r\nb\r\n');
		expect(session.baseline).toBe('a\r\nb\r\n');
		expect(session.dirty).toBe(false);
		expect(session.editorState?.selection.main.anchor).toBe(4);
		controller.detach(lease);
	});

	it('makes an attached editor read-only while refresh is pending', () => {
		const { session, controller } = createController();
		session.editorState = null;
		const lease = controller.attach(parent());

		session.refreshing = true;
		controller.reconfigure();
		expect(session.editorState?.facet(EditorState.readOnly)).toBe(true);

		session.refreshing = false;
		controller.reconfigure();
		expect(session.editorState?.facet(EditorState.readOnly)).toBe(false);
		controller.detach(lease);
	});
});
