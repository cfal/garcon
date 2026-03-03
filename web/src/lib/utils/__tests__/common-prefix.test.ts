import { describe, it, expect } from 'vitest';
import { computeCommonDirPrefix, applyDirPrefix } from '../common-prefix.js';

describe('computeCommonDirPrefix', () => {
	it('returns empty string for empty input', () => {
		expect(computeCommonDirPrefix([])).toBe('');
	});

	it('includes filename for a single file', () => {
		expect(computeCommonDirPrefix(['server/git/git-service.js'])).toBe('server/git/git-service.js');
	});

	it('trims extension for a single file when trimExtension is true', () => {
		expect(computeCommonDirPrefix(['server/git/git-service.js'], true)).toBe('server/git/git-service');
	});

	it('finds common directory prefix across multiple files', () => {
		expect(computeCommonDirPrefix([
			'server/git/git-service.js',
			'server/git/git-error-classifier.js',
		])).toBe('server/git');
	});

	it('filters out generic tokens like src and lib', () => {
		expect(computeCommonDirPrefix([
			'src/components/Button.svelte',
			'src/components/Input.svelte',
		])).toBe('components');
	});

	it('returns empty string when only generic tokens remain', () => {
		expect(computeCommonDirPrefix([
			'src/foo.ts',
			'src/bar.ts',
		])).toBe('');
	});

	it('ignores lock files when computing prefix', () => {
		expect(computeCommonDirPrefix([
			'server/git/git-service.js',
			'package-lock.lock',
			'go.sum',
		])).toBe('server/git/git-service.js');
	});

	it('falls back to all files when every file is ignored', () => {
		expect(computeCommonDirPrefix(['go.sum', 'Cargo.lock'])).toBe('');
	});

	it('returns empty when files have no common directory', () => {
		expect(computeCommonDirPrefix([
			'server/foo.ts',
			'web/bar.ts',
		])).toBe('');
	});

	it('preserves dotted directory segments in multi-file prefix', () => {
		expect(computeCommonDirPrefix([
			'web/vite.config/a.ts',
			'web/vite.config/b.ts',
		])).toBe('web/vite.config');
	});

	it('handles root-level files (no directories)', () => {
		expect(computeCommonDirPrefix(['README.md', 'LICENSE'])).toBe('');
	});

	it('ignores .lockb files', () => {
		expect(computeCommonDirPrefix([
			'web/src/components/Foo.svelte',
			'bun.lockb',
		])).toBe('web/components/Foo.svelte');
	});

	it('filters generic tokens from single-file path', () => {
		expect(computeCommonDirPrefix(['src/lib/utils/foo.ts'])).toBe('utils/foo.ts');
	});

	it('filters generic tokens from single-file path with trimExtension', () => {
		expect(computeCommonDirPrefix(['src/lib/utils/foo.ts'], true)).toBe('utils/foo');
	});

	it('filters sources token', () => {
		expect(computeCommonDirPrefix([
			'sources/api/handler.go',
			'sources/api/router.go',
		])).toBe('api');
	});

	it('single root-level file returns its name', () => {
		expect(computeCommonDirPrefix(['package.json'])).toBe('package.json');
	});

	it('single root-level file with trimExtension strips extension', () => {
		expect(computeCommonDirPrefix(['package.json'], true)).toBe('package');
	});
});

describe('applyDirPrefix', () => {
	it('prepends prefix to message', () => {
		expect(applyDirPrefix('add a new feature', 'server/git'))
			.toBe('server/git: add a new feature');
	});

	it('prepends prefix to conventional commit as-is', () => {
		expect(applyDirPrefix('feat: add feature', 'server/git'))
			.toBe('server/git: feat: add feature');
	});

	it('preserves multiline body', () => {
		const msg = 'add feature\n\nDetailed description here.';
		expect(applyDirPrefix(msg, 'web'))
			.toBe('web: add feature\n\nDetailed description here.');
	});

	it('returns original message when prefix is empty', () => {
		expect(applyDirPrefix('fix: something', '')).toBe('fix: something');
	});

	it('returns original message when message is empty', () => {
		expect(applyDirPrefix('', 'web')).toBe('');
	});
});
