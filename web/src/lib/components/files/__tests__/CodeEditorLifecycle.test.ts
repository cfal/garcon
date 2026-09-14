import { cleanup, render, waitFor } from '@testing-library/svelte';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
import { CodeEditorController } from '$lib/files/editor/code-editor-controller.svelte.js';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
import CodeEditorLifecycleTestHost from './CodeEditorLifecycleTestHost.svelte';

afterEach(cleanup);

describe('CodeEditor lifecycle', () => {
	it.each([true, false])(
		'reconfigures guards without replacing a renderer (pending activation: %s)',
		async (waitForProvider) => {
			const documentState = new FileDocumentState(
				{
					canonicalFileRootPath: '/workspace',
					normalizedRelativePath: 'file.txt',
				},
				'file',
			);
			documentState.content = 'local edit';
			const session = new FileViewSession(documentState);
			const settings = createLocalSettingsStore();
			const controller = new CodeEditorController(session, {
				editorThemeId: 'standard-light',
				wordWrap: false,
				showLineNumbers: true,
				fontSize: 14,
			});
			session.editor = controller;
			const bridge = new SurfaceFrameBridge();
			const activated = bridge.activate(waitForProvider);
			const rendered = render(CodeEditorLifecycleTestHost, { session, settings, bridge });
			try {
				await activated;
				await waitFor(() => expect(controller.isAttached).toBe(true));
				const renderer = rendered.container.querySelector('.cm-editor');
				controller.run('find');
				const search = rendered.container.querySelector<HTMLInputElement>('[name="search"]')!;
				search.focus();
				const guards = [
					(value: boolean) => {
						documentState.readOnly = value;
					},
					(value: boolean) => {
						documentState.mixedLineEndings = value;
					},
					(value: boolean) => {
						documentState.refreshing = value;
					},
				];
				for (const guard of guards) {
					guard(true);
					await waitFor(() => expect(session.editorState?.facet(EditorState.readOnly)).toBe(true));
					expect(rendered.container.querySelector('.cm-editor')).toBe(renderer);
					expect(document.activeElement).toBe(search);
					guard(false);
					await waitFor(() => expect(session.editorState?.facet(EditorState.readOnly)).toBe(false));
				}
				EditorView.findFromDOM(renderer as HTMLElement)!.dispatch({ selection: { anchor: 5 } });
				bridge.deactivate();
				await waitFor(() => expect(rendered.getByText('Ln 1, Col 6')).toBeTruthy());
				const sibling = new FileViewSession(documentState);
				const siblingController = new CodeEditorController(sibling, {
					editorThemeId: 'standard-light',
					wordWrap: false,
					showLineNumbers: true,
					fontSize: 14,
				});
				const siblingHost = document.createElement('div');
				document.body.append(siblingHost);
				try {
					siblingController.attach(siblingHost);
					const view = EditorView.findFromDOM(
						siblingHost.querySelector<HTMLElement>('.cm-editor')!,
					)!;
					view.dispatch({ changes: { from: 0, insert: 'new\n' }, userEvent: 'input.type' });
					await waitFor(() => expect(rendered.getByText('Ln 2, Col 6')).toBeTruthy());
					await bridge.activate(true);
					expect(rendered.getByText('Ln 2, Col 6')).toBeTruthy();
				} finally {
					siblingController.dispose();
					sibling.dispose();
					siblingHost.remove();
				}
			} finally {
				rendered.unmount();
				bridge.deactivate();
				controller.dispose();
				session.dispose();
			}
		},
	);
});
