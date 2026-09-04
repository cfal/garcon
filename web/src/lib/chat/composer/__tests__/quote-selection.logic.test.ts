import { describe, expect, it } from 'vitest';
import { formatQuoteBlock } from '../quote-selection.js';

describe('formatQuoteBlock', () => {
	it.each([
		{ text: 'hello', expected: '> hello\n\n' },
		{ text: 'hello\nworld', expected: '> hello\n> world\n\n' },
		{ text: 'hello\r\nworld', expected: '> hello\n> world\n\n' },
		{ text: 'hello\rworld', expected: '> hello\n> world\n\n' },
		{ text: 'first\n\nsecond', expected: '> first\n> \n> second\n\n' },
		{ text: '  spaced  ', expected: '>   spaced  \n\n' },
		{ text: 'trailing\n', expected: '> trailing\n> \n\n' },
		{ text: '', expected: '' },
		{ text: '   \n\t', expected: '' },
	])('quotes $text as $expected', ({ text, expected }) => {
		expect(formatQuoteBlock(text)).toBe(expected);
	});
});
