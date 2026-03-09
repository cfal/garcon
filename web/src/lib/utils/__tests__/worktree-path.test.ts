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
	it('derives path from branch name', () => {
		expect(deriveWorktreePath('fix/login-bug')).toBe('../.worktrees/fix-login-bug');
	});

	it('returns empty string for empty branch', () => {
		expect(deriveWorktreePath('')).toBe('');
		expect(deriveWorktreePath('   ')).toBe('');
	});

	it('handles complex branch names', () => {
		expect(deriveWorktreePath('feat/ui/dark-mode')).toBe('../.worktrees/feat-ui-dark-mode');
	});
});
