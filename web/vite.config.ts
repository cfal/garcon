import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import path from 'node:path';
import { CODEMIRROR_PACKAGES } from './codemirror-packages.ts';
import { codeMirrorLanguageChunk } from './codemirror-chunks.ts';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			// A single locale keeps production output compact while avoiding one module per message in dev.
			outputStructure: 'locale-modules',
		}),
	],
	resolve: {
		alias: {
			$shared: path.resolve(import.meta.dirname, '../common'),
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
				codeSplitting: {
					groups: [
						{
							name: 'vendor-svelte',
							test: (id) => id.includes('/node_modules/svelte/'),
							// Reserves the shared runtime before lazy vendors collect their dependencies.
							priority: 20,
						},
						{
							name: 'vendor-canvas',
							test: (id) => id.includes('@xyflow/') || id.includes('@svelte-put/shortcut'),
							priority: 10,
						},
						{
							name: 'vendor-codemirror-core',
							test: (id) =>
								id.includes('@codemirror/language/') ||
								id.includes('@codemirror/state/') ||
								id.includes('@lezer/highlight/') ||
								id.includes('@lezer/common/') ||
								id.includes('@lezer/lr/'),
							// Metadata needs the shared runtime, not the language packs that import it.
							priority: 15,
						},
						{
							name(id) {
								if (id.includes('@xterm/')) return 'vendor-xterm';
								if (id.includes('node_modules/katex')) return 'vendor-katex';
								if (id.includes('@replit/codemirror-vim')) return 'vendor-codemirror-vim';

								const languageChunk = codeMirrorLanguageChunk(id);
								if (languageChunk) return languageChunk;

								if (
									id.includes('@codemirror/view') ||
									id.includes('@codemirror/commands') ||
									id.includes('@codemirror/merge') ||
									id.includes('@codemirror/search') ||
									id.includes('@codemirror/theme-one-dark')
								)
									return 'vendor-codemirror-editor';

								if (id.includes('@codemirror/') || id.includes('codemirror'))
									return 'vendor-codemirror';

								if (id.includes('@atlaskit/pragmatic-drag-and-drop')) return 'vendor-dnd';
							},
						},
					],
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
		},
	},
});
