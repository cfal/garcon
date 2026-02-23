import { describe, it, expect } from 'vitest';
import { computeCommonDirPrefix, applyDirPrefix } from '../common-prefix.js';

describe('computeCommonDirPrefix', () => {
	it('returns empty string for empty input', () => {
		expect(computeCommonDirPrefix([])).toBe('');
	});

	it('returns the directory for a single file', () => {
		expect(computeCommonDirPrefix(['server/git/git-service.js'])).toBe('server/git');
	});

	it('finds common prefix across multiple files', () => {
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
		])).toBe('server/git');
	});

	it('returns empty when all files are lockfiles', () => {
		expect(computeCommonDirPrefix(['go.sum', 'Cargo.lock'])).toBe('');
	});

	it('returns empty when files have no common directory', () => {
		expect(computeCommonDirPrefix([
			'server/foo.ts',
			'web/bar.ts',
		])).toBe('');
	});

	it('strips extension when prefix resolves to a single file-like segment', () => {
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
		])).toBe('web/components');
	});
});

describe('applyDirPrefix', () => {
	it('replaces scope in conventional commit with scope', () => {
		expect(applyDirPrefix('feat(old): add feature', 'server/git'))
			.toBe('feat(server/git): add feature');
	});

	it('inserts scope in conventional commit without scope', () => {
		expect(applyDirPrefix('fix: resolve issue', 'server/git'))
			.toBe('fix(server/git): resolve issue');
	});

	it('prepends prefix to non-conventional message', () => {
		expect(applyDirPrefix('add a new feature', 'server/git'))
			.toBe('server/git: add a new feature');
	});

	it('preserves multiline body', () => {
		const msg = 'feat: add feature\n\nDetailed description here.';
		expect(applyDirPrefix(msg, 'web'))
			.toBe('feat(web): add feature\n\nDetailed description here.');
	});

	it('returns original message when prefix is empty', () => {
		expect(applyDirPrefix('fix: something', '')).toBe('fix: something');
	});

	it('returns original message when message is empty', () => {
		expect(applyDirPrefix('', 'web')).toBe('');
	});

	it('handles all conventional commit types', () => {
		const types = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore'];
		for (const type of types) {
			expect(applyDirPrefix(`${type}: something`, 'api'))
				.toBe(`${type}(api): something`);
		}
	});
});
