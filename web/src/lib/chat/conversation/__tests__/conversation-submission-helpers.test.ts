import { describe, expect, it } from 'vitest';
import { errorDetail } from '../conversation-submission-helpers.js';

describe('conversation submission helpers', () => {
	it('uses the error name when the browser omits the message', () => {
		expect(errorDetail(new DOMException('', 'NetworkError'))).toBe('NetworkError');
	});

	it('never returns an empty error detail', () => {
		expect(errorDetail(new Error(''))).toBe('Unknown error');
		expect(errorDetail('')).toBe('Unknown error');
	});
});
