import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
	plugins: [svelte()],
	test: {
		environment: 'happy-dom',
		globals: true,
		include: ['src/**/*.test.ts'],
		alias: {
			$lib: new URL('./src/lib', import.meta.url).pathname,
			$app: new URL('./src/lib/mocks/app', import.meta.url).pathname,
			$shared: new URL('../common', import.meta.url).pathname,
		},
	},
	resolve: {
		conditions: ['browser'],
	},
});
