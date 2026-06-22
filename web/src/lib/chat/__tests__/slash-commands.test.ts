import { describe, expect, it } from 'vitest';
import {
	applySlashCommand,
	findSlashCommandTrigger,
	matchSlashCommands,
	parseCompactCommand,
} from '../slash-commands';

describe('findSlashCommandTrigger', () => {
	it('detects an in-progress command word', () => {
		expect(findSlashCommandTrigger('/comp')).toEqual({ query: 'comp' });
		expect(findSlashCommandTrigger('/')).toEqual({ query: '' });
	});

	it('stops triggering once arguments begin', () => {
		expect(findSlashCommandTrigger('/compact ')).toBeNull();
		expect(findSlashCommandTrigger('/compact focus on api')).toBeNull();
	});

	it('only triggers at the start of the input', () => {
		expect(findSlashCommandTrigger(' /compact')).toBeNull();
		expect(findSlashCommandTrigger('hello /compact')).toBeNull();
		expect(findSlashCommandTrigger('@compact')).toBeNull();
	});
});

describe('matchSlashCommands', () => {
	it('matches commands by prefix, case-insensitive', () => {
		expect(matchSlashCommands('comp').map((c) => c.name)).toEqual(['compact']);
		expect(matchSlashCommands('COMP').map((c) => c.name)).toEqual(['compact']);
		expect(matchSlashCommands('').map((c) => c.name)).toContain('compact');
	});

	it('returns nothing for an unknown command', () => {
		expect(matchSlashCommands('zzz')).toEqual([]);
	});
});

describe('applySlashCommand', () => {
	it('produces a typed command with a trailing space for arguments', () => {
		expect(applySlashCommand('compact')).toBe('/compact ');
	});
});

describe('parseCompactCommand', () => {
	it('recognizes a bare compact command', () => {
		expect(parseCompactCommand('/compact')).toEqual({ instructions: '' });
		expect(parseCompactCommand('  /compact  ')).toEqual({ instructions: '' });
	});

	it('captures focus instructions', () => {
		expect(parseCompactCommand('/compact focus on the API design')).toEqual({
			instructions: 'focus on the API design',
		});
	});

	it('is case-insensitive on the command word', () => {
		expect(parseCompactCommand('/COMPACT keep decisions')).toEqual({
			instructions: 'keep decisions',
		});
	});

	it('does not match similar or non-leading text', () => {
		expect(parseCompactCommand('/compacted')).toBeNull();
		expect(parseCompactCommand('please /compact')).toBeNull();
	});
});
