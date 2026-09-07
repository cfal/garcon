import { describe, expect, it } from 'vitest';
import { errorMessage } from '../error-message.js';

describe('errorMessage', () => {
	it('prefers a non-empty Error message', () => {
		expect(errorMessage(new Error('request failed'), 'fallback')).toBe('request failed');
	});

	it('uses the fallback for non-errors and empty messages', () => {
		expect(errorMessage({ code: 'FAILED' }, 'fallback')).toBe('fallback');
		expect(errorMessage(new Error(''), 'fallback')).toBe('fallback');
	});
});
