import { describe, expect, it } from 'vitest';
import { parseHandoffCommand } from '../handoff-command.js';

describe('parseHandoffCommand', () => {
	it('captures the message that starts the continuation', () => {
		expect(parseHandoffCommand('/handoff keep going on the auth fix')).toEqual({
			message: 'keep going on the auth fix',
		});
	});

	it('accepts the bare command and trims surrounding space', () => {
		expect(parseHandoffCommand('/handoff')).toEqual({ message: '' });
		expect(parseHandoffCommand('  /handoff   continue  ')).toEqual({ message: 'continue' });
	});

	it('keeps multi-line messages intact', () => {
		expect(parseHandoffCommand('/handoff first line\nsecond line')).toEqual({
			message: 'first line\nsecond line',
		});
	});

	it('ignores text that only mentions the command', () => {
		expect(parseHandoffCommand('please /handoff this')).toBeNull();
		// A longer word starting with the command name is not the command.
		expect(parseHandoffCommand('/handoffs are useful')).toBeNull();
	});
});
