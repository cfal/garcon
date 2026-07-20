import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { CODEMIRROR_PACKAGES } from './codemirror-packages';

// Excludes the CodeMirror package whose export map has no root entry for Vite to prebundle.
const TEST_OPTIMIZED_DEPENDENCIES = [
	...CODEMIRROR_PACKAGES.filter((packageName) => packageName !== '@codemirror/legacy-modes'),
	'katex',
];

export default defineConfig({
	plugins: [svelte()],
	optimizeDeps: {
		include: TEST_OPTIMIZED_DEPENDENCIES,
	},
	test: {
		environment: 'happy-dom',
		globals: true,
		// Reuses worker threads while retaining an isolated VM context for each test file.
		// Cross-realm boundary values must use shape checks rather than constructor identity.
		pool: 'vmThreads',
		setupFiles: ['./src/test/vitest-setup.ts'],
		include: ['src/**/*.test.ts'],
		server: {
			deps: {
				// CodeMirror extensions rely on instanceof checks from @codemirror/state.
				// Inline the whole family so Vitest cannot mix externalized and Vite-transformed copies.
				inline: [...CODEMIRROR_PACKAGES],
			},
		},
		alias: {
			$lib: new URL('./src/lib', import.meta.url).pathname,
			$app: new URL('./src/lib/mocks/app', import.meta.url).pathname,
			$shared: new URL('../common', import.meta.url).pathname,
		},
	},
	resolve: {
		conditions: ['browser'],
		// CodeMirror extensions rely on instanceof checks from @codemirror/state.
		dedupe: [...CODEMIRROR_PACKAGES],
	},
});
