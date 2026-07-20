import { describe, it, expect } from 'vitest';
import { sanitizeBranchForPath, deriveWorktreePath } from '../worktree-path.js';

describe('sanitizeBranchForPath', () => {
	it('replaces slashes with hyphens', () => {
		expect(sanitizeBranchForPath('fix/login-bug')).toBe('fix-login-bug');
		expect(sanitizeBranchForPath('feat/ui/modal')).toBe('feat-ui-modal');
	});

	it('replaces backslashes with hyphens', () => {
		expect(sanitizeBranchForPath('fix\\bug')).toBe('fix-bug');
	});

	it('replaces unsafe characters', () => {
		expect(sanitizeBranchForPath('feat: new thing!')).toBe('feat-new-thing');
	});

	it('collapses consecutive hyphens', () => {
		expect(sanitizeBranchForPath('a//b///c')).toBe('a-b-c');
	});

	it('strips leading and trailing hyphens', () => {
		expect(sanitizeBranchForPath('/leading')).toBe('leading');
		expect(sanitizeBranchForPath('trailing/')).toBe('trailing');
	});

	it('trims whitespace', () => {
		expect(sanitizeBranchForPath('  branch  ')).toBe('branch');
	});

	it('preserves dots and underscores', () => {
		expect(sanitizeBranchForPath('v1.0_release')).toBe('v1.0_release');
	});

	it('returns empty string for empty input', () => {
		expect(sanitizeBranchForPath('')).toBe('');
		expect(sanitizeBranchForPath('   ')).toBe('');
	});

	it('rejects dot-only names to prevent path traversal', () => {
		expect(sanitizeBranchForPath('..')).toBe('');
		expect(sanitizeBranchForPath('.')).toBe('');
		expect(sanitizeBranchForPath('...')).toBe('');
	});

	it('preserves dot-prefixed names that are not pure dots', () => {
		expect(sanitizeBranchForPath('.config')).toBe('.config');
		expect(sanitizeBranchForPath('..hidden')).toBe('..hidden');
	});
});

describe('deriveWorktreePath', () => {
	it('derives a path inside the repository root', () => {
		expect(deriveWorktreePath('/workspace/repo', 'fix/login-bug')).toBe(
			'/workspace/repo/.worktrees/fix-login-bug',
		);
	});

	it('returns empty string for an empty repository root or branch', () => {
		expect(deriveWorktreePath('', 'feature')).toBe('');
		expect(deriveWorktreePath('   ', 'feature')).toBe('');
		expect(deriveWorktreePath('/workspace/repo', '')).toBe('');
		expect(deriveWorktreePath('/workspace/repo', '   ')).toBe('');
	});

	it('handles repository roots with trailing separators', () => {
		expect(deriveWorktreePath('/workspace/repo/', 'feat/ui/dark-mode')).toBe(
			'/workspace/repo/.worktrees/feat-ui-dark-mode',
		);
		expect(deriveWorktreePath('/', 'feature')).toBe('/.worktrees/feature');
	});

	it('preserves Windows path separators', () => {
		expect(deriveWorktreePath('C:\\workspace\\repo\\', 'feat/ui')).toBe(
			'C:\\workspace\\repo\\.worktrees\\feat-ui',
		);
	});
});
