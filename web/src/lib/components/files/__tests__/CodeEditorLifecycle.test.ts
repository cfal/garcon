import { cleanup, render, waitFor } from '@testing-library/svelte';
import { EditorState } from '@codemirror/state';
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
						documentState.recoveryGuard = value;
					},
					(value: boolean) => {
						documentState.refreshing = value;
					},
					(value: boolean) => {
						documentState.recoveredCopies = value
							? [{ id: 'copy', content: 'recovered', savedAt: 1, hasUnknownSubmission: false }]
							: [];
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
			} finally {
				rendered.unmount();
				bridge.deactivate();
				controller.dispose();
				session.dispose();
			}
		},
	);
});
