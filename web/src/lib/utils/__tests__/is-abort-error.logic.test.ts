import { describe, expect, it } from 'vitest';
import { isAbortError } from '../is-abort-error.js';

describe('isAbortError', () => {
	it('recognizes DOMException aborts', () => {
		expect(isAbortError(new DOMException('superseded', 'AbortError'))).toBe(true);
	});

	it('recognizes Error and plain-object abort shapes', () => {
		const error = new Error('superseded');
		error.name = 'AbortError';

		expect(isAbortError(error)).toBe(true);
		expect(isAbortError({ name: 'AbortError' })).toBe(true);
	});

	it.each([new Error('failure'), { name: 'OtherError' }, null, undefined, 'AbortError'])(
		'rejects non-abort value %#',
		(value) => {
			expect(isAbortError(value)).toBe(false);
		},
	);
});
