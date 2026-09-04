import { describe, expect, it } from 'vitest';
import {
	compileHiddenBashCommandPatterns,
	isHiddenBashToolUse,
	normalizeHiddenBashCommandPatterns,
	validateHiddenBashCommandPattern,
} from '$lib/chat/transcript/hidden-bash-commands.js';
import { BashToolUseMessage, ReadToolUseMessage } from '$shared/chat-types';

describe('compileHiddenBashCommandPatterns', () => {
	it('matches glob patterns against the whole command', () => {
		const matches = compileHiddenBashCommandPatterns([{ pattern: 'git *', mode: 'glob' }]);
		expect(matches?.('git status')).toBe(true);
		expect(matches?.('git')).toBe(false);
		expect(matches?.('echo git status')).toBe(false);
	});

	it('treats glob question marks as single-character wildcards', () => {
		const matches = compileHiddenBashCommandPatterns([{ pattern: 'ls -?a', mode: 'glob' }]);
		expect(matches?.('ls -la')).toBe(true);
		expect(matches?.('ls -lla')).toBe(false);
	});

	it('matches astral characters as one glob character', () => {
		const matches = compileHiddenBashCommandPatterns([{ pattern: 'echo ?', mode: 'glob' }]);
		expect(matches?.('echo 😀')).toBe(true);
		expect(matches?.('echo a😀')).toBe(false);
	});

	it('escapes glob literals that are regular-expression metacharacters', () => {
		const matches = compileHiddenBashCommandPatterns([{ pattern: 'rg foo(bar)', mode: 'glob' }]);
		expect(matches?.('rg foo(bar)')).toBe(true);
		expect(matches?.('rg foobar')).toBe(false);
	});

	it('matches regex patterns as substrings', () => {
		const matches = compileHiddenBashCommandPatterns([
			{ pattern: '^git (status|log)', mode: 'regex' },
		]);
		expect(matches?.('git status')).toBe(true);
		expect(matches?.('git log --oneline')).toBe(true);
		expect(matches?.('echo git status')).toBe(false);
		expect(matches?.('git push')).toBe(false);
	});

	it('matches when any pattern hits', () => {
		const matches = compileHiddenBashCommandPatterns([
			{ pattern: 'cargo *', mode: 'glob' },
			{ pattern: 'make\\s', mode: 'regex' },
		]);
		expect(matches?.('cargo build')).toBe(true);
		expect(matches?.('make test')).toBe(true);
		expect(matches?.('bun run test')).toBe(false);
	});

	it('returns null when the list is empty or every pattern fails to compile', () => {
		expect(compileHiddenBashCommandPatterns([])).toBeNull();
		expect(
			compileHiddenBashCommandPatterns([{ pattern: '([unclosed', mode: 'regex' }]),
		).toBeNull();
	});

	it('matches multiline commands through glob wildcards', () => {
		const matches = compileHiddenBashCommandPatterns([{ pattern: 'bun run*', mode: 'glob' }]);
		expect(matches?.('bun run test &&\nbun run check')).toBe(true);
	});
});

describe('validateHiddenBashCommandPattern', () => {
	it('rejects blank patterns', () => {
		expect(validateHiddenBashCommandPattern('', 'glob')).toBe('empty');
		expect(validateHiddenBashCommandPattern('   ', 'regex')).toBe('empty');
	});

	it('rejects regex patterns that fail to compile', () => {
		expect(validateHiddenBashCommandPattern('([unclosed', 'regex')).toBe('invalid-regex');
	});

	it('accepts valid patterns per mode', () => {
		expect(validateHiddenBashCommandPattern('git *', 'glob')).toBe('ok');
		expect(validateHiddenBashCommandPattern('^git', 'regex')).toBe('ok');
	});
});

describe('normalizeHiddenBashCommandPatterns', () => {
	it('drops malformed entries and duplicates', () => {
		expect(
			normalizeHiddenBashCommandPatterns([
				{ pattern: 'git *', mode: 'glob' },
				{ pattern: 'git *', mode: 'glob' },
				{ pattern: '^git', mode: 'regex' },
				{ pattern: '', mode: 'glob' },
				{ pattern: '([unclosed', mode: 'regex' },
				{ pattern: 'x', mode: 'shell' },
				{ pattern: 42, mode: 'glob' },
				'string',
				null,
			]),
		).toEqual([
			{ pattern: 'git *', mode: 'glob' },
			{ pattern: '^git', mode: 'regex' },
		]);
	});

	it('preserves pattern text exactly', () => {
		expect(normalizeHiddenBashCommandPatterns([{ pattern: '  spaced  ', mode: 'glob' }])).toEqual([
			{ pattern: '  spaced  ', mode: 'glob' },
		]);
	});

	it('drops whitespace-only patterns', () => {
		expect(
			normalizeHiddenBashCommandPatterns([
				{ pattern: '   ', mode: 'regex' },
				{ pattern: 'git *', mode: 'glob' },
			]),
		).toEqual([{ pattern: 'git *', mode: 'glob' }]);
	});

	it('keeps the same pattern under different modes', () => {
		expect(
			normalizeHiddenBashCommandPatterns([
				{ pattern: 'git *', mode: 'glob' },
				{ pattern: 'git *', mode: 'regex' },
			]),
		).toHaveLength(2);
	});

	it('returns an empty list for non-array input', () => {
		expect(normalizeHiddenBashCommandPatterns(undefined)).toEqual([]);
		expect(normalizeHiddenBashCommandPatterns('nope')).toEqual([]);
	});
});

describe('isHiddenBashToolUse', () => {
	const matches = compileHiddenBashCommandPatterns([{ pattern: 'git *', mode: 'glob' }]);
	if (!matches) throw new Error('expected compiled bash command matcher');
	const TS = '2026-09-04T00:00:00.000Z';

	it('matches bash tool use whose command is hidden', () => {
		expect(isHiddenBashToolUse(new BashToolUseMessage(TS, 't1', 'git status'), matches)).toBe(
			true,
		);
		expect(isHiddenBashToolUse(new BashToolUseMessage(TS, 't2', 'bun test'), matches)).toBe(
			false,
		);
	});

	it('ignores other tool types', () => {
		expect(isHiddenBashToolUse(new ReadToolUseMessage(TS, 't3', '/tmp/a.ts'), matches)).toBe(
			false,
		);
		expect(isHiddenBashToolUse(undefined, matches)).toBe(false);
	});
});
