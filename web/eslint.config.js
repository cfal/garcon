import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import { defineConfig } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

import svelteConfig from './svelte.config.js';

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
	eslintConfigPrettier,
	svelte.configs.prettier,
	{
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
		rules: {
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
					paths: [
						{
							name: '@lucide/svelte',
							message: 'Import individual icons from @lucide/svelte/icons/*.',
						},
					],
				},
			],
		},
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				svelteConfig,
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
					patterns: [
						{
							regex: '^(?:\\$lib/components/|(?:\\.\\.?/)+components/)',
							message:
								'Move reusable behavior to its domain; non-component modules cannot import components.',
						},
					],
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
					patterns: [
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
		files: ['**/*.svelte'],
		rules: {
			'@typescript-eslint/no-unused-expressions': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
		},
	},
	{
		files: ['src/**/*.test.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
);
