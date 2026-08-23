import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
// Keeps the lifecycle assertion independent of lazy-module transform latency.
import '$lib/components/prompt-editor/PromptEditor.svelte';
import PromptComposerTestHost from './PromptComposerTestHost.svelte';

describe('PromptEditor integration', () => {
	afterEach(() => {
		cleanup();
		document.body.innerHTML = '';
	});

	it('keeps one EditorView while external composer text synchronizes', async () => {
		render(PromptComposerTestHost, { selectedChatId: 'chat-editor-lifecycle' });
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'initial text' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));

		let editorElement: HTMLElement | null = null;
		await waitFor(() => {
			editorElement = document.querySelector<HTMLElement>('.cm-editor');
			expect(editorElement).toBeTruthy();
		});
		if (!editorElement) throw new Error('Expected a CodeMirror editor');
		const view = EditorView.findFromDOM(editorElement);
		if (!view) throw new Error('Expected the CodeMirror view');

		await fireEvent.input(textarea, { target: { value: 'external replacement' } });

		await waitFor(() => expect(view.state.doc.toString()).toBe('external replacement'));
		expect(document.querySelector('.cm-editor')).toBe(editorElement);
	});
});
