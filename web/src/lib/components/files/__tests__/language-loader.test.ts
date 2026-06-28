import { ensureSyntaxTree } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { loadLanguageExtension } from '../language-loader';

async function loadIntoState(filePath: string, doc: string): Promise<EditorState> {
	const languageCompartment = new Compartment();
	const editorState = EditorState.create({
		doc,
		extensions: [languageCompartment.of([])],
	});
	const extensions = await loadLanguageExtension(filePath);
	const transaction = editorState.update({
		effects: languageCompartment.reconfigure(extensions),
	});

	expect(extensions.length).toBeGreaterThan(0);
	return transaction.state;
}

describe('loadLanguageExtension', () => {
	it('loads a .svelte language extension that CodeMirror can reconfigure', async () => {
		const editorState = await loadIntoState(
			'Counter.svelte',
			'<script lang="ts">let count = 0;</script>\n<button>{count}</button>',
		);

		expect(editorState.doc.lines).toBe(2);
	});

	it('loads Go language support through the editor reconfigure path', async () => {
		const editorState = await loadIntoState(
			'main.go',
			'package main\n\nfunc main() {\n\tprintln("hello")\n}\n',
		);

		expect(ensureSyntaxTree(editorState, editorState.doc.length, 100)).toBeTruthy();
	});

});
