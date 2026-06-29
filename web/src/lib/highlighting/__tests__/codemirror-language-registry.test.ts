import { describe, expect, it } from 'vitest';

import {
	canHighlightCodeFenceLanguage,
	loadCodeFenceLanguage,
	loadLanguageExtension,
	normalizeCodeFenceLanguage,
} from '../codemirror-language-registry';

describe('normalizeCodeFenceLanguage', () => {
	it('normalizes common aliases and info-string forms', () => {
		expect(normalizeCodeFenceLanguage('js')).toBe('javascript');
		expect(normalizeCodeFenceLanguage('ts')).toBe('typescript');
		expect(normalizeCodeFenceLanguage('{.py}')).toBe('python');
		expect(normalizeCodeFenceLanguage('rs title="main.rs"')).toBe('rust');
		expect(normalizeCodeFenceLanguage('golang')).toBe('go');
		expect(normalizeCodeFenceLanguage('md')).toBe('markdown');
		expect(normalizeCodeFenceLanguage('h')).toBe('cpp');
		expect(normalizeCodeFenceLanguage('hpp')).toBe('cpp');
		expect(normalizeCodeFenceLanguage('cc')).toBe('cpp');
		expect(normalizeCodeFenceLanguage('cxx')).toBe('cpp');
		expect(normalizeCodeFenceLanguage('svg')).toBe('xml');
		expect(normalizeCodeFenceLanguage('txt')).toBe('plaintext');
		expect(normalizeCodeFenceLanguage('yml')).toBe('yaml');
		expect(normalizeCodeFenceLanguage('sh')).toBe('shell');
		expect(normalizeCodeFenceLanguage('cs')).toBe('c#');
		expect(normalizeCodeFenceLanguage('kt')).toBe('kotlin');
		expect(normalizeCodeFenceLanguage('kts')).toBe('kotlin');
		expect(normalizeCodeFenceLanguage('angular')).toBe('angular template');
		expect(normalizeCodeFenceLanguage('patch')).toBe('diff');
	});
});

describe('canHighlightCodeFenceLanguage', () => {
	it('recognizes supported CodeMirror languages and no-op languages', () => {
		expect(canHighlightCodeFenceLanguage('plaintext')).toBe(false);
		expect(canHighlightCodeFenceLanguage('txt')).toBe(false);
		expect(canHighlightCodeFenceLanguage('unknown-language')).toBe(false);
		expect(canHighlightCodeFenceLanguage('diff')).toBe(true);
		expect(canHighlightCodeFenceLanguage('js')).toBe(true);
		expect(canHighlightCodeFenceLanguage('yaml')).toBe(true);
		expect(canHighlightCodeFenceLanguage('bash')).toBe(true);
		expect(canHighlightCodeFenceLanguage('csharp')).toBe(true);
		expect(canHighlightCodeFenceLanguage('ruby')).toBe(true);
		expect(canHighlightCodeFenceLanguage('swift')).toBe(true);
		expect(canHighlightCodeFenceLanguage('kotlin')).toBe(true);
	});
});

describe('loadCodeFenceLanguage', () => {
	it.each([
		['yaml', 'yaml'],
		['bash', 'shell'],
		['csharp', 'c#'],
		['rb', 'ruby'],
		['swift', 'swift'],
		['kt', 'kotlin'],
		['angular', 'angular template'],
	])('loads %s through CodeMirror language-data', async (language, expectedKey) => {
		const loaded = await loadCodeFenceLanguage(language);
		expect(loaded?.key).toBe(expectedKey);
		expect(loaded?.language.parser).toBeTruthy();
		expect(loaded?.extensions.length).toBeGreaterThan(0);
	});

	it('does not load a parser for manual diff highlighting', async () => {
		await expect(loadCodeFenceLanguage('diff')).resolves.toBeNull();
	});
});

describe('loadLanguageExtension', () => {
	it.each([
		'main.go',
		'config.yaml',
		'script.sh',
		'Program.cs',
		'lib/foo.rb',
		'main.swift',
		'App.kt',
		'style.scss',
		'theme.less',
		'Component.vue',
		'template.liquid',
		'template.jinja',
		'Dockerfile',
		'settings.toml',
		'Counter.svelte',
		'Containerfile',
	])('loads editor support for %s', async (filePath) => {
		const extensions = await loadLanguageExtension(filePath);
		expect(extensions.length).toBeGreaterThan(0);
	});

	it('leaves Makefile unsupported until CodeMirror publishes official metadata', async () => {
		await expect(loadLanguageExtension('Makefile')).resolves.toEqual([]);
	});

	it('uses explicit editor language before filename matching', async () => {
		const extensions = await loadLanguageExtension({
			filePath: 'notes.txt',
			language: 'typescript',
		});

		expect(extensions.length).toBeGreaterThan(0);
	});
});
