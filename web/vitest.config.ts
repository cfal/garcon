import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { CODEMIRROR_PACKAGES } from './codemirror-packages';

// Excludes the CodeMirror package whose export map has no root entry for Vite to prebundle.
const TEST_OPTIMIZED_DEPENDENCIES = [
	...CODEMIRROR_PACKAGES.filter((packageName) => packageName !== '@codemirror/legacy-modes'),
	'katex',
];
const IMPORT_AUDIT_ENABLED = process.env.VITEST_IMPORT_AUDIT === '1';

export default defineConfig({
	plugins: [svelte()],
	optimizeDeps: {
		include: TEST_OPTIMIZED_DEPENDENCIES,
	},
	test: {
		experimental: {
			importDurations: {
				print: IMPORT_AUDIT_ENABLED,
				limit: IMPORT_AUDIT_ENABLED ? 50 : 0,
			},
		},
		projects: [
			// Logic tests opt in by filename after avoiding components, browser globals, and module mocks.
			{
				extends: true,
				test: {
					name: 'logic',
					environment: 'node',
					globals: true,
					include: ['src/**/*.logic.test.ts'],
					isolate: false,
					pool: 'threads',
					setupFiles: [],
				},
			},
			{
				extends: true,
				test: {
					name: 'ui',
					environment: 'happy-dom',
					exclude: ['src/**/*.logic.test.ts'],
					globals: true,
					include: ['src/**/*.test.ts'],
					// Reuses worker threads while retaining an isolated VM context for each test file.
					// Cross-realm boundary values must use shape checks rather than constructor identity.
					pool: 'vmThreads',
					setupFiles: ['./src/test/vitest-setup.ts'],
				},
			},
		],
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
