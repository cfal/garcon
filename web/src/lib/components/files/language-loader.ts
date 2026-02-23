// Lazy loader for CodeMirror language extensions. Each language pack is
// dynamically imported on first use, avoiding upfront bundle cost.

import type { Extension } from '@codemirror/state';

type LanguageFactory = () => Promise<Extension[]>;

const loaders: Record<string, LanguageFactory> = {
	js: async () => {
		const { javascript } = await import('@codemirror/lang-javascript');
		return [javascript({ jsx: true })];
	},
	jsx: async () => {
		const { javascript } = await import('@codemirror/lang-javascript');
		return [javascript({ jsx: true })];
	},
	ts: async () => {
		const { javascript } = await import('@codemirror/lang-javascript');
		return [javascript({ jsx: true, typescript: true })];
	},
	tsx: async () => {
		const { javascript } = await import('@codemirror/lang-javascript');
		return [javascript({ jsx: true, typescript: true })];
	},
	py: async () => {
		const { python } = await import('@codemirror/lang-python');
		return [python()];
	},
	html: async () => {
		const { html } = await import('@codemirror/lang-html');
		return [html()];
	},
	htm: async () => {
		const { html } = await import('@codemirror/lang-html');
		return [html()];
	},
	svelte: async () => {
		const { html } = await import('@codemirror/lang-html');
		return [html()];
	},
	vue: async () => {
		const { html } = await import('@codemirror/lang-html');
		return [html()];
	},
	css: async () => {
		const { css } = await import('@codemirror/lang-css');
		return [css()];
	},
	scss: async () => {
		const { css } = await import('@codemirror/lang-css');
		return [css()];
	},
	less: async () => {
		const { css } = await import('@codemirror/lang-css');
		return [css()];
	},
	json: async () => {
		const { json } = await import('@codemirror/lang-json');
		return [json()];
	},
	md: async () => {
		const { markdown } = await import('@codemirror/lang-markdown');
		return [markdown()];
	},
	markdown: async () => {
		const { markdown } = await import('@codemirror/lang-markdown');
		return [markdown()];
	},
	rs: async () => {
		const { rust } = await import('@codemirror/lang-rust');
		return [rust()];
	},
	sql: async () => {
		const { sql } = await import('@codemirror/lang-sql');
		return [sql()];
	},
	xml: async () => {
		const { xml } = await import('@codemirror/lang-xml');
		return [xml()];
	},
	svg: async () => {
		const { xml } = await import('@codemirror/lang-xml');
		return [xml()];
	},
	java: async () => {
		const { java } = await import('@codemirror/lang-java');
		return [java()];
	},
	c: async () => {
		const { cpp } = await import('@codemirror/lang-cpp');
		return [cpp()];
	},
	h: async () => {
		const { cpp } = await import('@codemirror/lang-cpp');
		return [cpp()];
	},
	cpp: async () => {
		const { cpp } = await import('@codemirror/lang-cpp');
		return [cpp()];
	},
	hpp: async () => {
		const { cpp } = await import('@codemirror/lang-cpp');
		return [cpp()];
	},
	cc: async () => {
		const { cpp } = await import('@codemirror/lang-cpp');
		return [cpp()];
	},
	cxx: async () => {
		const { cpp } = await import('@codemirror/lang-cpp');
		return [cpp()];
	},
	php: async () => {
		const { php } = await import('@codemirror/lang-php');
		return [php()];
	},
};

/** Resolves the CodeMirror language extension for a file path. */
export async function loadLanguageExtension(filePath: string): Promise<Extension[]> {
	const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
	const loader = loaders[ext];
	if (!loader) return [];
	return loader();
}
