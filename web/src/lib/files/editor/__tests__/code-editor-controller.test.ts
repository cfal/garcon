import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import type { CanonicalFileIdentity } from '$shared/file-contracts';
import { FileSession } from '$lib/files/sessions/__tests__/file-session-fixture.js';
import { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
import { CodeEditorController } from '$lib/files/editor/code-editor-controller.svelte.js';
import { emulateDetachedScrollReset } from '../../../../test/detached-scroll.js';

const mounted: HTMLElement[] = [];
const controllers: CodeEditorController[] = [];

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
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
		get editorThemeId() {
			return 'standard-light' as const;
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
	const controller = new CodeEditorController(session, settings);
	controllers.push(controller);
	return { session, controller };
}

describe('CodeEditorController', () => {
	it.each([false, true])(
		'drops stale restored folds before shared edits (attached: %s)',
		(attached) => {
			const { session, controller } = createController();
			controller.replaceContentFromDisk('short');
			const host = parent();
			if (attached) controller.attach(host);
			controller.restorePresentation({ line: 1, column: 1, endLine: 1, endColumn: 1 }, [
				{ from: 1, to: 3 },
				{ from: 2, to: 200 },
				{ from: -1, to: 2 },
				{ from: 2, to: 2 },
				{ from: 3, to: 2 },
				{ from: 1.5, to: 3 },
				{ from: 0, to: NaN },
			]);
			expect(controller.folds()).toEqual([{ from: 1, to: 3 }]);
			if (!attached) controller.attach(host);
			const sibling = new FileViewSession(session.document);
			const siblingController = new CodeEditorController(sibling, {
				editorThemeId: 'standard-light',
				wordWrap: false,
				showLineNumbers: true,
				fontSize: 12,
			});
			controllers.push(siblingController);
			const siblingHost = parent();
			siblingController.attach(siblingHost);
			const view = EditorView.findFromDOM(siblingHost.querySelector<HTMLElement>('.cm-editor')!)!;
			const changed = vi.fn();
			const stop = session.document.onChange(changed);
			expect(() =>
				view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input.type' }),
			).not.toThrow();
			expect(session.document.currentContent()).toBe('short!');
			expect(session.dirty).toBe(true);
			expect(changed).toHaveBeenCalledOnce();
			expect(session.editorState?.doc.toString()).toBe('short!');
			expect(view.state.doc.toString()).toBe('short!');
			expect(controller.run('undo')).toBe(true);
			expect(view.state.doc.toString()).toBe('short');
			expect(session.dirty).toBe(false);
			stop();
			sibling.dispose();
		},
	);

	it('caches bounded indentation sampling across cursor updates and invalidates it after edits', () => {
		const { session, controller } = createController();
		controller.replaceContentFromDisk('first\n    second\nthird');
		const host = parent();
		controller.attach(host);
		const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
		const sample = vi.spyOn(view.state.doc, 'iterRange');
		expect(controller.status.indentation).toBe('Spaces: 4');
		view.dispatch({ selection: { anchor: 0 } });
		expect(controller.status.line).toBe(1);
		expect(controller.status.indentation).toBe('Spaces: 4');
		expect(sample).toHaveBeenCalledOnce();
		view.dispatch({ changes: { from: 6, to: 10, insert: '\t' }, userEvent: 'input.type' });
		expect(controller.status.indentation).toBe('Tabs');
		expect(controller.run('undo')).toBe(true);
		expect(controller.status.indentation).toBe('Spaces: 4');
		controller.replaceContentFromDisk('x'.repeat(12_000_000));
		const largeDocument = session.editorState!.doc;
		const stringify = vi.spyOn(largeDocument, 'toString');
		const largeSample = vi.spyOn(largeDocument, 'iterRange');
		expect(controller.status.indentation).toBe('Spaces: 2');
		expect(controller.status.indentation).toBe('Spaces: 2');
		expect(stringify).not.toHaveBeenCalled();
		expect(largeSample).toHaveBeenCalledExactlyOnceWith(0, 16 * 1024);
	});

	it('keeps Find compact, counts matches, navigates, and expands Replace on demand', async () => {
		const { session, controller } = createController();
		session.content = 'word word word';
		const host = parent();
		controller.attach(host);
		controller.run('find');
		const search = host.querySelector<HTMLInputElement>('input[name="search"]')!;
		const row = host.querySelector<HTMLElement>('.cm-file-search-replace')!;
		expect(row.hidden).toBe(true);
		search.value = 'word';
		search.dispatchEvent(new Event('input'));
		const result = host.querySelector('[role="status"]')!;
		await vi.waitFor(() => expect(result.textContent).toBe('3 matches'));
		host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click();
		expect(result.textContent).toMatch(/^[1-3] of 3$/);
		controller.run('replace');
		expect(row.hidden).toBe(false);
		expect(document.activeElement?.getAttribute('name')).toBe('replace');
		session.refreshing = true;
		controller.reconfigure();
		expect(host.querySelector<HTMLButtonElement>('[aria-label="Replace all"]')!.disabled).toBe(
			true,
		);
		expect(host.querySelector<HTMLInputElement>('input[name="replace"]')!.disabled).toBe(true);
	});

	it('keeps singular and cleared search announcements distinct from no results', async () => {
		const { controller } = createController();
		const host = parent();
		controller.attach(host);
		controller.run('find');
		const search = host.querySelector<HTMLInputElement>('input[name="search"]')!;
		const result = host.querySelector<HTMLElement>('[role="status"]')!;
		search.value = 'first';
		search.dispatchEvent(new Event('input'));
		await vi.waitFor(() => expect(result.textContent).toBe('1 match'));
		expect(result.dataset.empty).toBe('false');

		search.value = '';
		search.dispatchEvent(new Event('input'));
		expect(result.textContent).toBe('');
		expect(result.dataset.empty).toBe('false');
		expect(search.getAttribute('aria-invalid')).toBe('false');
	});

	it('counts only the captured selection and reports invalid regex without native controls', async () => {
		const { session, controller } = createController();
		session.content = 'word word word';
		const host = parent();
		controller.attach(host);
		const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
		view.dispatch({ selection: { anchor: 0, head: 9 } });
		controller.run('find');
		const search = host.querySelector<HTMLInputElement>('input[name="search"]')!;
		search.value = 'word';
		search.dispatchEvent(new Event('input'));
		const scope = host.querySelector<HTMLInputElement>('input[name="selection"]')!;
		scope.click();
		await vi.waitFor(() =>
			expect(host.querySelector('[role="status"]')?.textContent).toBe('2 matches'),
		);
		host.querySelector<HTMLInputElement>('input[name="regexp"]')!.click();
		search.value = '[';
		search.dispatchEvent(new Event('input'));
		expect(search.getAttribute('aria-invalid')).toBe('true');
		expect(host.querySelector('[role="status"]')?.textContent).toBe('Invalid regex');
		expect(host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.disabled).toBe(true);
		for (const button of host.querySelectorAll('.cm-file-search button')) {
			expect(button.querySelector('svg')).not.toBeNull();
			expect(button.getAttribute('aria-label')).toBeTruthy();
		}
	});

	it('bounds match counts and keeps composing Escape inside Find', async () => {
		const { session, controller } = createController();
		session.content = 'a '.repeat(1100);
		const host = parent();
		controller.attach(host);
		controller.run('find');
		const search = host.querySelector<HTMLInputElement>('input[name="search"]')!;
		search.value = 'a';
		search.dispatchEvent(new Event('input'));
		await vi.waitFor(() =>
			expect(host.querySelector('[role="status"]')?.textContent).toBe('1000+ matches'),
		);
		const composing = new KeyboardEvent('keydown', {
			key: 'Escape',
			isComposing: true,
			bubbles: true,
			cancelable: true,
		});
		search.dispatchEvent(composing);
		expect(composing.defaultPrevented).toBe(false);
		expect(host.querySelector('.cm-file-search')).not.toBeNull();
		search.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
		);
		expect(host.querySelector('.cm-file-search')).toBeNull();
	});
	it.each([
		['ab(?=c)', '1 of 1', false, 'Xc'],
		['ab$', 'No results', true, 'abc'],
	] as const)(
		'keeps full regex context for scoped %s counts and replacement',
		async (query, count, disabled, result) => {
			const { session, controller } = createController();
			session.content = 'abc';
			const host = parent();
			controller.attach(host);
			const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
			view.dispatch({ selection: { anchor: 0, head: 2 } });
			controller.run('replace');
			const search = host.querySelector<HTMLInputElement>('input[name="search"]')!;
			search.value = query;
			search.dispatchEvent(new Event('input'));
			host.querySelector<HTMLInputElement>('input[name="regexp"]')!.click();
			host.querySelector<HTMLInputElement>('input[name="selection"]')!.click();
			const replace = host.querySelector<HTMLInputElement>('input[name="replace"]')!;
			replace.value = 'X';
			replace.dispatchEvent(new Event('input'));
			await vi.waitFor(() =>
				expect(host.querySelector('[role="status"]')?.textContent).toBe(count),
			);
			expect(host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.disabled).toBe(
				disabled,
			);
			const replaceAll = host.querySelector<HTMLButtonElement>('[aria-label="Replace all"]')!;
			expect(replaceAll.disabled).toBe(disabled);
			replaceAll.click();
			expect(controller.currentContent()).toBe(result);
		},
	);
	it('moves one editor state and its scroll position between hosts', async () => {
		const { session, controller } = createController();
		const firstParent = parent();
		const secondParent = parent();

		const firstLease = controller.attach(firstParent);
		const firstScroller = firstParent.querySelector<HTMLElement>('.cm-scroller');
		if (!firstScroller) throw new Error('Expected CodeMirror scroller');
		expect(controller.scrollElement).toBe(firstScroller);
		emulateDetachedScrollReset(firstScroller);
		firstScroller.scrollLeft = 9;
		firstScroller.scrollTop = 24;
		firstScroller.dispatchEvent(new Event('scroll'));
		firstParent.remove();
		controller.prepareRendererTransfer();
		const secondLease = controller.attach(secondParent);
		controller.detach(firstLease);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const secondScroller = secondParent.querySelector<HTMLElement>('.cm-scroller');

		expect(controller.isAttached).toBe(true);
		expect(controller.scrollElement).toBe(secondScroller);
		expect(firstParent.querySelector('.cm-editor')).toBeNull();
		expect(secondParent.querySelector('.cm-editor')).not.toBeNull();
		expect(session.editorScrollSnapshot).not.toBeNull();
		expect(secondScroller?.scrollLeft).toBe(9);
		expect(secondScroller?.scrollTop).toBe(24);
		controller.detach(secondLease);
		expect(controller.isAttached).toBe(false);
		expect(controller.scrollElement).toBeNull();
		expect(session.editorState?.doc.toString()).toBe('first\nsecond\nthird');
		expect(session.editorState?.selection.main.anchor).toBe(8);
	});

	it('rejects overlapping renderer attachment', () => {
		const { controller } = createController();
		controller.attach(parent());

		expect(() => controller.attach(parent())).toThrow('already attached');
		controller.dispose();
	});

	it('floors touch font size while preserving the configured fine-pointer size', () => {
		const { session, controller } = createController();
		session.editorState = null;
		const host = parent();
		controller.attach(host);
		const editor = host.querySelector<HTMLElement>('.cm-editor');
		if (!editor) throw new Error('Expected CodeMirror editor');

		const styleRules = [...document.querySelectorAll('style')]
			.map((style) => style.textContent ?? '')
			.join('\n');
		const matchingScope = [...editor.classList]
			.filter((className) => className !== 'cm-editor')
			.map((className) => {
				const scope = `.${className}`;
				return {
					floorIndex: styleRules.indexOf(
						`${scope} .cm-content, ${scope} .cm-gutters {font-size: 16px;`,
					),
					configuredIndex: styleRules.indexOf(
						`@media (pointer: fine) {${scope} .cm-content, ${scope} .cm-gutters {font-size: 12px;`,
					),
				};
			})
			.find(({ floorIndex, configuredIndex }) => floorIndex >= 0 && configuredIndex > floorIndex);
		expect(matchingScope).toBeDefined();
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
		session.content = 'first\r\nsecond!';
		const editedLease = controller.attach(parent());

		expect(session.dirty).toBe(true);
		expect(controller.currentContent()).toBe('first\r\nsecond!');
		controller.detach(editedLease);
	});

	it('preserves lone carriage-return line endings when serializing', () => {
		const { session, controller } = createController();
		controller.replaceContentFromDisk('first\rsecond');
		const lease = controller.attach(parent());

		expect(session.dirty).toBe(false);
		expect(controller.currentContent()).toBe('first\rsecond');

		controller.detach(lease);
		session.content = 'first\rsecond!';
		const editedLease = controller.attach(parent());

		expect(session.dirty).toBe(true);
		expect(controller.currentContent()).toBe('first\rsecond!');
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
		host
			.querySelector<HTMLElement>('.cm-content')
			?.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
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

	it('opens an accessible Find and Replace panel with selection-only results', async () => {
		const { controller } = createController();
		const host = parent();
		controller.attach(host);

		expect(controller.run('find')).toBe(true);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const search = document.querySelector<HTMLInputElement>('input[name="search"]');
		const replace = document.querySelector<HTMLInputElement>('input[name="replace"]');
		const selectionOnly = document.querySelector<HTMLInputElement>('input[name="selection"]');
		if (!search || !replace || !selectionOnly) throw new Error('Expected search controls');
		expect(selectionOnly.disabled).toBe(true);
		search.value = 'missing';
		search.dispatchEvent(new Event('input'));

		expect(search.getAttribute('aria-label')).toBe('Find');
		expect(replace.getAttribute('aria-label')).toBe('Replace');
		expect(selectionOnly.getAttribute('aria-label')).toBe('Selection only');
		await vi.waitFor(() =>
			expect(document.querySelector('.cm-search [role="status"]')?.textContent).toBe('No results'),
		);
		search.value = 'first';
		search.dispatchEvent(new Event('input'));
		replace.value = 'replacement';
		replace.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
		);
		expect(controller.currentContent()).toBe('first\nsecond\nthird');
	});

	it('maps a selection-only search scope through replacements', async () => {
		const { session, controller } = createController();
		session.content = 'a a a';
		const host = parent();
		controller.attach(host);
		const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!);
		if (!view) throw new Error('Expected CodeMirror view');
		view.dispatch({ selection: { anchor: 0, head: 3 } });
		controller.run('find');
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const search = document.querySelector<HTMLInputElement>('input[name="search"]');
		const selectionOnly = document.querySelector<HTMLInputElement>('input[name="selection"]');
		controller.run('replace');
		const replaceAll = document.querySelector<HTMLButtonElement>(
			'.cm-search button[aria-label="Replace all"]',
		);
		if (!search || !selectionOnly || !replaceAll) throw new Error('Expected search controls');
		search.value = 'a';
		search.dispatchEvent(new Event('input'));
		selectionOnly.checked = true;
		selectionOnly.dispatchEvent(new Event('change'));

		expect(() => replaceAll.click()).not.toThrow();
		replaceAll.click();

		expect(controller.currentContent()).toBe('  a');
	});

	it('focuses Replace when opened through its command', async () => {
		const { controller } = createController();
		const host = parent();
		controller.attach(host);

		expect(controller.run('replace')).toBe(true);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		expect(document.activeElement?.getAttribute('name')).toBe('replace');
	});

	it('dismisses the Go to Line dialog through the local Escape path', async () => {
		const { controller } = createController();
		const host = parent();
		controller.attach(host);

		expect(controller.run('go-to-line')).toBe(true);
		expect(host.querySelector('.cm-goto-line')).not.toBeNull();
		expect(controller.closeDialog()).toBe(true);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		expect(host.querySelector('.cm-goto-line')).toBeNull();
	});

	it('selects the next occurrence as an additional range', () => {
		const { session, controller } = createController();
		session.content = 'word word';
		const host = parent();
		controller.attach(host);
		const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!);
		if (!view) throw new Error('Expected CodeMirror view');
		view.dispatch({ selection: { anchor: 0, head: 4 } });

		expect(controller.run('select-next-occurrence')).toBe(true);
		expect(view.state.selection.ranges).toHaveLength(2);
	});

	it('retains the default insert-blank-line shortcut', () => {
		const { controller } = createController();
		const host = parent();
		controller.attach(host);
		const content = host.querySelector<HTMLElement>('.cm-content');
		if (!content) throw new Error('Expected CodeMirror content');

		content.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Enter',
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(controller.currentContent()).toBe('first\nsecond\n\nthird');
	});

	it('retains the default additional-cursor shortcut', () => {
		const { controller } = createController();
		const host = parent();
		controller.attach(host);
		const content = host.querySelector<HTMLElement>('.cm-content');
		const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!);
		if (!content || !view) throw new Error('Expected CodeMirror editor');

		content.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'ArrowDown',
				ctrlKey: true,
				altKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(view.state.selection.ranges).toHaveLength(2);
	});

	it('routes Undo and Redo through canonical document history', () => {
		const { session, controller } = createController();
		const host = parent();
		controller.attach(host);
		const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!);
		if (!view) throw new Error('Expected CodeMirror view');
		view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });

		expect(controller.run('undo')).toBe(true);
		expect(controller.currentContent()).toBe('first\nsecond\nthird');
		expect(controller.run('redo')).toBe(true);
		expect(controller.currentContent()).toBe('xfirst\nsecond\nthird');
		expect(session.dirty).toBe(true);
	});

	it('makes an attached editor read-only while refresh is pending', () => {
		const { session, controller } = createController();
		session.editorState = null;
		const lease = controller.attach(parent());

		session.refreshing = true;
		controller.reconfigure();
		expect((session.editorState as EditorState | null)?.facet(EditorState.readOnly)).toBe(true);

		session.refreshing = false;
		controller.reconfigure();
		expect((session.editorState as EditorState | null)?.facet(EditorState.readOnly)).toBe(false);
		controller.detach(lease);
	});

	it('reapplies dynamic configuration when a retained editor reattaches', () => {
		const { session, controller } = createController();
		const firstLease = controller.attach(parent());
		session.refreshing = true;
		controller.reconfigure();
		controller.detach(firstLease);
		session.refreshing = false;

		const secondLease = controller.attach(parent());

		expect((session.editorState as EditorState | null)?.facet(EditorState.readOnly)).toBe(false);
		controller.detach(secondLease);
	});

	it('applies restored scroll after the attached editor is measured', async () => {
		const { session, controller } = createController();
		const host = parent();
		const lease = controller.attach(host);
		session.textScrollLeft = 12;
		session.textScrollTop = 80;

		controller.restorePresentation({ line: 1, column: 1, endLine: 1, endColumn: 1 }, []);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		const scroller = host.querySelector<HTMLElement>('.cm-scroller');
		expect(scroller?.scrollLeft).toBe(12);
		expect(scroller?.scrollTop).toBe(80);
		controller.detach(lease);
	});
});
