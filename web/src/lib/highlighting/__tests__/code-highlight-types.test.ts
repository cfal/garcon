import { describe, expect, it } from 'vitest';

import { plainCodeSegments } from '../code-highlight-types';

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
