import { describe, expect, it } from 'vitest';
import {
	compileHiddenBashCommandPatterns,
	createHiddenBashCommandMatcherCache,
	HIDDEN_BASH_COMMAND_PATTERN_PRESETS,
	isHiddenBashToolUse,
	validateHiddenBashCommandPattern,
} from '$lib/chat/transcript/hidden-bash-commands.js';
import { BashToolUseMessage, ReadToolUseMessage } from '$shared/chat-types';

describe('compileHiddenBashCommandPatterns', () => {
	it('matches Garcon-Amp launcher commands without matching embedded paths', () => {
		const [preset] = HIDDEN_BASH_COMMAND_PATTERN_PRESETS;
		const matches = compileHiddenBashCommandPatterns(preset.patterns);

		expect(matches?.('/tmp/garcon-amp-1788487172419500/oracle --status')).toBe(true);
		expect(matches?.('/tmp/garcon-amp-1788487172419500/oracle --review "diff"')).toBe(true);
		expect(matches?.('./finder --start "locate settings"')).toBe(true);
		expect(matches?.('./reporter')).toBe(true);
		expect(matches?.('./reporter-extra --status')).toBe(false);
		expect(matches?.('/tmp/garcon-amp-123/oracle-extra --status')).toBe(false);
		expect(matches?.('echo /tmp/garcon-amp-123/oracle --status')).toBe(false);
		expect(matches?.('x/oracle --status')).toBe(false);
	});

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

	it('rejects patterns over the shared length limit', () => {
		expect(validateHiddenBashCommandPattern('x'.repeat(1_001), 'glob')).toBe('too-long');
	});

	it('accepts valid patterns per mode', () => {
		expect(validateHiddenBashCommandPattern('git *', 'glob')).toBe('ok');
		expect(validateHiddenBashCommandPattern('^git', 'regex')).toBe('ok');
	});
});

describe('createHiddenBashCommandMatcherCache', () => {
	it('reuses a matcher for value-identical lists', () => {
		const matcherFor = createHiddenBashCommandMatcherCache();
		const first = matcherFor([{ pattern: 'git *', mode: 'glob' }]);
		const second = matcherFor([{ pattern: 'git *', mode: 'glob' }]);

		expect(first).not.toBeNull();
		expect(second).toBe(first);
	});

	it('creates a new matcher for each semantic list change', () => {
		const matcherFor = createHiddenBashCommandMatcherCache();
		const base = matcherFor([
			{ pattern: 'git *', mode: 'glob' },
			{ pattern: '^cargo', mode: 'regex' },
		]);
		const changes = [
			[
				{ pattern: 'git *', mode: 'regex' as const },
				{ pattern: '^cargo', mode: 'regex' as const },
			],
			[
				{ pattern: 'git ?', mode: 'glob' as const },
				{ pattern: '^cargo', mode: 'regex' as const },
			],
			[
				{ pattern: '^cargo', mode: 'regex' as const },
				{ pattern: 'git *', mode: 'glob' as const },
			],
			[{ pattern: 'git *', mode: 'glob' as const }],
			[
				{ pattern: 'git *', mode: 'glob' as const },
				{ pattern: '^cargo', mode: 'regex' as const },
				{ pattern: 'bun *', mode: 'glob' as const },
			],
		];

		for (const patterns of changes) {
			expect(matcherFor(patterns)).not.toBe(base);
		}
	});

	it('does not reuse a matcher after the caller mutates the prior input', () => {
		const matcherFor = createHiddenBashCommandMatcherCache();
		const patterns = [{ pattern: 'git *', mode: 'glob' as const }];
		const first = matcherFor(patterns);
		patterns[0].pattern = 'cargo *';

		expect(matcherFor(patterns)).not.toBe(first);
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
