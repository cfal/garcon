import { ensureSyntaxTree } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { loadLanguageExtension } from '$lib/files/editor/language-loader.js';

async function loadIntoState(
	filePath: string,
	doc: string,
	language?: string,
): Promise<EditorState> {
	const languageCompartment = new Compartment();
	const editorState = EditorState.create({
		doc,
		extensions: [languageCompartment.of([])],
	});
	const extensions = await loadLanguageExtension({ filePath, language });
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

	it('loads official YAML support through the editor reconfigure path', async () => {
		const editorState = await loadIntoState('config.yaml', 'name: garcon\nenabled: true\n');

		expect(ensureSyntaxTree(editorState, editorState.doc.length, 100)).toBeTruthy();
	});

	it('uses the explicit language argument when the filename is ambiguous', async () => {
		const editorState = await loadIntoState(
			'snippet.txt',
			'const value: number = 1;',
			'typescript',
		);

		expect(ensureSyntaxTree(editorState, editorState.doc.length, 100)).toBeTruthy();
	});
});
