import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide'
		})
	],
	resolve: {
		alias: {
			$shared: path.resolve(__dirname, '../common')
		}
	},
	build: {
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes('@xterm/')) return 'vendor-xterm';
					if (id.includes('@codemirror/') || id.includes('codemirror')) return 'vendor-codemirror';
					if (id.includes('@thisbeyond/') || id.includes('dnd-kit')) return 'vendor-dnd';
				}
			}
		}
	},
	server: {
		proxy: {
			'/api': 'http://localhost:3001',
			'/ws': {
				target: 'ws://localhost:3001',
				ws: true
			},
			'/shell': {
				target: 'ws://localhost:3001',
				ws: true
			}
		}
	}
});
