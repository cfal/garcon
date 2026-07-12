import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import path from 'node:path';
import { CODEMIRROR_PACKAGES } from './codemirror-packages';

function codeMirrorLanguageChunk(id: string): string | undefined {
	if (
		id.includes('@codemirror/lang-javascript') ||
		id.includes('@codemirror/lang-json') ||
		id.includes('@lezer/javascript') ||
		id.includes('@lezer/json')
	) {
		return 'vendor-cm-lang-web';
	}

	if (
		id.includes('@codemirror/lang-html') ||
		id.includes('@codemirror/lang-css') ||
		id.includes('@codemirror/lang-xml') ||
		id.includes('@codemirror/lang-sass') ||
		id.includes('@codemirror/lang-less') ||
		id.includes('@codemirror/lang-vue') ||
		id.includes('@lezer/html') ||
		id.includes('@lezer/css') ||
		id.includes('@lezer/sass') ||
		id.includes('@lezer/xml')
	) {
		return 'vendor-cm-lang-markup';
	}

	if (
		id.includes('@codemirror/lang-cpp') ||
		id.includes('@codemirror/lang-go') ||
		id.includes('@codemirror/lang-java') ||
		id.includes('@codemirror/lang-php') ||
		id.includes('@codemirror/lang-python') ||
		id.includes('@codemirror/lang-rust') ||
		id.includes('@codemirror/lang-sql') ||
		id.includes('@codemirror/lang-yaml') ||
		id.includes('@lezer/cpp') ||
		id.includes('@lezer/go') ||
		id.includes('@lezer/java') ||
		id.includes('@lezer/php') ||
		id.includes('@lezer/python') ||
		id.includes('@lezer/rust') ||
		id.includes('@lezer/yaml')
	) {
		return 'vendor-cm-lang-programming';
	}

	if (
		id.includes('@codemirror/lang-angular') ||
		id.includes('@codemirror/lang-jinja') ||
		id.includes('@codemirror/lang-liquid') ||
		id.includes('@lezer/markdown')
	) {
		return 'vendor-cm-lang-template';
	}

	if (id.includes('@codemirror/language-data') || id.includes('@codemirror/lang-markdown')) {
		return 'vendor-cm-lang-metadata';
	}

	if (id.includes('@codemirror/legacy-modes')) {
		return 'vendor-cm-legacy-modes';
	}
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
		}),
	],
	resolve: {
		alias: {
			$shared: path.resolve(__dirname, '../common'),
		},
		// CodeMirror extensions rely on instanceof checks from @codemirror/state.
		dedupe: [...CODEMIRROR_PACKAGES],
	},
	optimizeDeps: {
		include: [...CODEMIRROR_PACKAGES],
	},
	build: {
		rollupOptions: {
				output: {
					manualChunks(id) {
						if (id.includes('@xterm/')) return 'vendor-xterm';
						if (id.includes('node_modules/katex')) return 'vendor-katex';

						const languageChunk = codeMirrorLanguageChunk(id);
						if (languageChunk) return languageChunk;

						if (
							id.includes('@codemirror/view') ||
							id.includes('@codemirror/commands') ||
							id.includes('@codemirror/merge') ||
							id.includes('@codemirror/theme-one-dark')
						)
							return 'vendor-codemirror-editor';

						if (
							id.includes('@codemirror/language') ||
							id.includes('@codemirror/state') ||
							id.includes('@lezer/highlight') ||
							id.includes('@lezer/common') ||
							id.includes('@lezer/lr')
						)
							return 'vendor-codemirror-core';

						if (id.includes('@codemirror/') || id.includes('codemirror'))
							return 'vendor-codemirror';

						if (
							id.includes('@atlaskit/pragmatic-drag-and-drop') ||
							id.includes('@tanstack/svelte-virtual') ||
						id.includes('@tanstack/virtual-core')
					)
						return 'vendor-dnd';
				},
			},
		},
	},
	server: {
		proxy: {
			'/api': 'http://localhost:3001',
			'/ws': {
				target: 'ws://localhost:3001',
				ws: true,
			},
			'/shell': {
				target: 'ws://localhost:3001',
				ws: true,
			},
		},
	},
});
