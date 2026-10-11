import { describe, expect, it } from 'vitest';
import { isClearCommand, isControllerSlashCommand } from '../slash-commands.js';

describe('/clear', () => {
	it.each(['/clear', '/clear ', '/clear\t\r\n'])('recognizes standalone %j', (source) => {
		expect(isClearCommand(source)).toBe(true);
		expect(isControllerSlashCommand(source)).toBe(true);
	});
	it.each([' /clear', '/Clear', '/clear argument', '/clear; pwd', '/clear\npwd', '/md /clear',
		'/markdown /clear', 'echo /clear', '/clear\0', '/clear\u00a0'])('leaves %j literal', (source) => {
		expect(isClearCommand(source)).toBe(false);
	});
});
