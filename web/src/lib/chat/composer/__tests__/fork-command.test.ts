import { describe, expect, it } from 'vitest';
import { parseForkCommand } from '$lib/chat/composer/fork-command.js';

describe('parseForkCommand', () => {
	it('parses a leading fork command', () => {
		expect(parseForkCommand('/fork continue here')).toEqual({ message: 'continue here' });
	});

	it('trims surrounding command message whitespace', () => {
		expect(parseForkCommand('  /fork   continue here  \n')).toEqual({ message: 'continue here' });
	});

	it('preserves multiline fork messages', () => {
		expect(parseForkCommand('/fork first line\nsecond line')).toEqual({
			message: 'first line\nsecond line',
		});
	});

	it('returns an empty message for a bare fork command', () => {
		expect(parseForkCommand('/fork')).toEqual({ message: '' });
		expect(parseForkCommand('/fork   ')).toEqual({ message: '' });
	});

	it('does not match similar text or non-leading commands', () => {
		expect(parseForkCommand('/forked continue')).toBeNull();
		expect(parseForkCommand('please /fork continue')).toBeNull();
		expect(parseForkCommand('@fork continue')).toBeNull();
	});
});
