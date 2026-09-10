import { ensureSyntaxTree } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { loadLanguageExtension } from '$lib/files/editor/language-loader.js';
import { collectFixture } from '../../../../test/collect-fixture.js';

// Cold parser transforms belong to bounded collection, not an editor assertion's timeout.
const [svelteExtensions, goExtensions, yamlExtensions, typescriptExtensions] = await collectFixture(
	Promise.all([
		loadLanguageExtension({ filePath: 'Counter.svelte' }),
		loadLanguageExtension({ filePath: 'main.go' }),
		loadLanguageExtension({ filePath: 'config.yaml' }),
		loadLanguageExtension({ filePath: 'snippet.txt', language: 'typescript' }),
	]),
	'editor language extensions',
);

function loadIntoState(extensions: Extension[], doc: string): EditorState {
	const languageCompartment = new Compartment();
	const editorState = EditorState.create({
		doc,
		extensions: [languageCompartment.of([])],
	});
	const transaction = editorState.update({
		effects: languageCompartment.reconfigure(extensions),
	});

	expect(extensions.length).toBeGreaterThan(0);
	return transaction.state;
}

describe('loadLanguageExtension', () => {
	it('loads a .svelte language extension that CodeMirror can reconfigure', () => {
		const editorState = loadIntoState(
			svelteExtensions,
			'<script lang="ts">let count = 0;</script>\n<button>{count}</button>',
		);

		expect(editorState.doc.lines).toBe(2);
	});

	it('loads Go language support through the editor reconfigure path', () => {
		const editorState = loadIntoState(
			goExtensions,
			'package main\n\nfunc main() {\n\tprintln("hello")\n}\n',
		);

		expect(ensureSyntaxTree(editorState, editorState.doc.length, 100)).toBeTruthy();
	});

	it('loads official YAML support through the editor reconfigure path', () => {
		const editorState = loadIntoState(yamlExtensions, 'name: garcon\nenabled: true\n');

		expect(ensureSyntaxTree(editorState, editorState.doc.length, 100)).toBeTruthy();
	});

	it('uses the explicit language argument when the filename is ambiguous', () => {
		const editorState = loadIntoState(typescriptExtensions, 'const value: number = 1;');

		expect(ensureSyntaxTree(editorState, editorState.doc.length, 100)).toBeTruthy();
	});
});
