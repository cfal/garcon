import { describe, expect, it } from 'vitest';
import {
	applySlashCommand,
	BUILTIN_SLASH_COMMANDS,
	findSlashCommandTrigger,
	parseCompactCommand,
	parseScheduleInCommand,
	parseSteerCommand,
} from '../slash-commands';

describe('slash command helpers', () => {
	it('detects a "/" trigger at the start of the input', () => {
		expect(findSlashCommandTrigger('/dogf', '/dogf'.length)).toEqual({
			start: 0,
			end: 5,
			query: 'dogf',
		});
	});

	it('detects a bare "/" with an empty query', () => {
		expect(findSlashCommandTrigger('/', 1)).toEqual({ start: 0, end: 1, query: '' });
	});

	it('does not trigger when "/" is not the first character', () => {
		expect(findSlashCommandTrigger('hello /world', 'hello /world'.length)).toBeNull();
		expect(findSlashCommandTrigger(' /world', ' /world'.length)).toBeNull();
	});

	it('stops triggering once the command token ends in whitespace', () => {
		expect(findSlashCommandTrigger('/dogfood ', '/dogfood '.length)).toBeNull();
		expect(findSlashCommandTrigger('/dogfood now', '/dogfood now'.length)).toBeNull();
	});

	it('replaces the trigger with the command and a trailing space', () => {
		const text = '/dogf';
		const trigger = findSlashCommandTrigger(text, text.length);
		expect(trigger).not.toBeNull();

		const replacement = applySlashCommand(text, trigger!, 'dogfood');
		expect(replacement.text).toBe('/dogfood ');
		expect(replacement.caret).toBe('/dogfood '.length);
	});

	it('preserves text after the caret when replacing mid-token', () => {
		// User typed "/clrest" with the caret after "/cl" (where the menu opened).
		const text = '/clrest';
		const trigger = findSlashCommandTrigger('/cl', '/cl'.length);
		expect(trigger).not.toBeNull();

		const replacement = applySlashCommand(text, trigger!, 'clear');
		expect(replacement.text).toBe('/clear rest');
		expect(replacement.caret).toBe('/clear '.length);
	});
});

describe('BUILTIN_SLASH_COMMANDS', () => {
	it('exposes built-ins with descriptions', () => {
		const compact = BUILTIN_SLASH_COMMANDS.find((command) => command.name === 'compact');
		const fork = BUILTIN_SLASH_COMMANDS.find((command) => command.name === 'fork');
		const goal = BUILTIN_SLASH_COMMANDS.find((command) => command.name === 'goal');
		const scheduleIn = BUILTIN_SLASH_COMMANDS.find((command) => command.name === 'in');
		const steer = BUILTIN_SLASH_COMMANDS.find((command) => command.name === 'steer');
		expect(compact).toBeDefined();
		expect(compact?.source).toBe('command');
		expect(compact?.description).toBeTruthy();
		expect(fork?.source).toBe('command');
		expect(fork?.description).toBeTruthy();
		expect(goal?.source).toBe('command');
		expect(goal?.description).toBeTruthy();
		expect(scheduleIn?.source).toBe('command');
		expect(scheduleIn?.description).toBeTruthy();
		expect(steer?.source).toBe('command');
		expect(steer?.description).toBeTruthy();
	});
});

describe('parseSteerCommand', () => {
	it('extracts multiline guidance case-insensitively', () => {
		expect(parseSteerCommand('/STEER Check the test\nthen continue')).toEqual({
			kind: 'valid',
			prompt: 'Check the test\nthen continue',
		});
	});

	it('requires guidance and ignores similar commands', () => {
		expect(parseSteerCommand('/steer')).toEqual({ kind: 'invalid' });
		expect(parseSteerCommand('/steering continue')).toEqual({ kind: 'not-command' });
	});
});

describe('parseScheduleInCommand', () => {
	it('parses ordered durations and multiline prompts', () => {
		expect(parseScheduleInCommand('/in 2h30m Continue the migration')).toEqual({
			kind: 'valid',
			duration: '2h30m',
			delayMinutes: 150,
			prompt: 'Continue the migration',
		});
		expect(parseScheduleInCommand('/IN 1D Review line one\nthen line two')).toEqual({
			kind: 'valid',
			duration: '1D',
			delayMinutes: 1_440,
			prompt: 'Review line one\nthen line two',
		});
	});

	it('returns specific duration and prompt errors', () => {
		expect(parseScheduleInCommand('/in')).toEqual({ kind: 'invalid', error: 'missing' });
		expect(parseScheduleInCommand('/in 2m10s Continue')).toEqual({
			kind: 'invalid',
			error: 'sub-minute-unsupported',
		});
		expect(parseScheduleInCommand('/in 30m2h Continue')).toEqual({
			kind: 'invalid',
			error: 'invalid-format',
		});
		expect(parseScheduleInCommand('/in 1m')).toEqual({
			kind: 'invalid',
			error: 'prompt-required',
		});
		expect(parseScheduleInCommand('/in 1m /compact')).toEqual({
			kind: 'invalid',
			error: 'slash-prompt-unsupported',
		});
	});

	it('does not claim similar or non-leading commands', () => {
		expect(parseScheduleInCommand('/inside 1m Continue')).toEqual({ kind: 'not-command' });
		expect(parseScheduleInCommand('please /in 1m Continue')).toEqual({ kind: 'not-command' });
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
