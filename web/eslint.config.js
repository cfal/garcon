import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import { defineConfig } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

const restrictedPaths = [{
	name: '@lucide/svelte',
	message: 'Import individual icons from @lucide/svelte/icons/*.',
}];
const componentBoundary = {
	regex: '^(?:\\$lib/components/|(?:\\.\\.?/)+components/)',
	message: 'Move reusable behavior to its domain; non-component modules cannot import components.',
};

export default defineConfig(
	{
		ignores: [
			'.svelte-kit/**',
			'build/**',
			'coverage/**',
			'dist/**',
			'node_modules/**',
			'src/lib/paraglide/**',
		],
	},
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs['flat/recommended'],
	eslintConfigPrettier,
	svelte.configs['flat/prettier'],
	{
		linterOptions: {
			reportUnusedDisableDirectives: 'error',
		},
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
		rules: {
			// Domain state replaces plain collections; SvelteMap and SvelteSet would alter effect tracking.
			'svelte/prefer-svelte-reactivity': 'off',
			// The SPA has no base path, and dynamic external URLs must remain untouched.
			'svelte/no-navigation-without-resolve': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
				},
			],
			'no-restricted-imports': [
				'error',
				{
					paths: restrictedPaths,
				},
			],
		},
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				svelteConfig: { compilerOptions: { runes: true } },
			},
		},
	},
	{
		files: ['src/lib/**/*.{ts,svelte}'],
		ignores: ['src/lib/components/**', 'src/lib/**/__tests__/**'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: restrictedPaths,
					patterns: [componentBoundary],
				},
			],
		},
	},
	{
		files: ['src/lib/utils/**/*.{ts,svelte}'],
		ignores: ['src/lib/utils/**/__tests__/**'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: restrictedPaths,
					patterns: [
						componentBoundary,
						{
							regex: '^(?:\\$lib/(?!utils/)|\\.\\./)',
							message:
								'Utilities cannot import higher layers; use $lib/utils for cross-folder utility imports.',
						},
					],
				},
			],
		},
	},
	{
		files: ['src/lib/**/*.{ts,svelte}'],
		ignores: ['src/lib/api/**', 'src/lib/**/__tests__/**'],
		rules: {
			'no-restricted-syntax': ['error', {
				selector: 'ImportSpecifier[imported.name="apiFetch"]',
				message: 'Keep raw authenticated HTTP handling in lib/api; consume a domain API function.',
			}],
		},
	},
	{
		files: ['**/*.svelte'],
		rules: {
			'@typescript-eslint/no-unused-expressions': 'off',
		},
	},
	{
		files: ['src/**/*.test.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
);
