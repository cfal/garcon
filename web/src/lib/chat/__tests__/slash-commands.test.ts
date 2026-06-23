import { describe, expect, it } from 'vitest';
import {
	applySlashCommand,
	BUILTIN_SLASH_COMMANDS,
	findSlashCommandTrigger,
	parseCompactCommand,
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
	it('exposes the compact built-in with a description', () => {
		const compact = BUILTIN_SLASH_COMMANDS.find((command) => command.name === 'compact');
		expect(compact).toBeDefined();
		expect(compact?.source).toBe('command');
		expect(compact?.description).toBeTruthy();
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
