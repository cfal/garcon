import { describe, expect, it } from 'vitest';

import { appendCodeHighlightSegment, plainCodeSegments } from '../code-highlight-types';

describe('appendCodeHighlightSegment', () => {
	it('merges adjacent segments with the same normalized class', () => {
		const segments = [{ text: 'const', className: 'cm-code-keyword' }];

		appendCodeHighlightSegment(segments, ' value', 'cm-code-keyword');
		appendCodeHighlightSegment(segments, ' = 1', '');
		appendCodeHighlightSegment(segments, ';', null);
		appendCodeHighlightSegment(segments, '', 'cm-code-title');

		expect(segments).toEqual([
			{ text: 'const value', className: 'cm-code-keyword' },
			{ text: ' = 1;', className: null },
		]);
	});
});

describe('plainCodeSegments', () => {
	it('returns no segments for empty text', () => {
		expect(plainCodeSegments('')).toEqual([]);
	});

	it('returns one unstyled segment for non-empty text', () => {
		expect(plainCodeSegments('const value = 1;')).toEqual([
			{ text: 'const value = 1;', className: null },
		]);
	});
});
