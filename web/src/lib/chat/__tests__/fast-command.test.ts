import { describe, expect, it } from 'vitest';
import { parseFastCommand } from '../fast-command';

describe('parseFastCommand', () => {
	it('parses a bare fast command as enable', () => {
		expect(parseFastCommand('/fast')).toEqual({ mode: 'enable' });
		expect(parseFastCommand('  /fast  ')).toEqual({ mode: 'enable' });
	});

	it('parses explicit fast command modes', () => {
		expect(parseFastCommand('/fast on')).toEqual({ mode: 'enable' });
		expect(parseFastCommand('/fast enable')).toEqual({ mode: 'enable' });
		expect(parseFastCommand('/fast off')).toEqual({ mode: 'disable' });
		expect(parseFastCommand('/fast disable')).toEqual({ mode: 'disable' });
		expect(parseFastCommand('/fast toggle')).toEqual({ mode: 'toggle' });
	});

	it('does not match similar text or unsupported arguments', () => {
		expect(parseFastCommand('/faster')).toBeNull();
		expect(parseFastCommand('please /fast')).toBeNull();
		expect(parseFastCommand('/fast please')).toBeNull();
	});
});
