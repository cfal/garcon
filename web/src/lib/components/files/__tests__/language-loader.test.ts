import { Compartment, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { loadLanguageExtension } from '../language-loader';

describe('loadLanguageExtension', () => {
	it('loads a .svelte language extension that CodeMirror can reconfigure', async () => {
		const languageCompartment = new Compartment();
		let editorState = EditorState.create({
			doc: '<script lang="ts">let count = 0;</script>\n<button>{count}</button>',
			extensions: [languageCompartment.of([])],
		});

		const extensions = await loadLanguageExtension('Counter.svelte');
		const transaction = editorState.update({
			effects: languageCompartment.reconfigure(extensions),
		});
		editorState = transaction.state;

		expect(extensions.length).toBeGreaterThan(0);
		expect(editorState.doc.lines).toBe(2);
	});
});
