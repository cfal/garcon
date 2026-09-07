import { describe, expect, it } from 'vitest';
import { safeLoginReturnTo } from './login-return-to';

describe('safeLoginReturnTo', () => {
	it.each([null, '', 'chat/one', '//example.com', '/\\example.com'])(
		'falls back to the app root for %j',
		(raw) => {
			expect(safeLoginReturnTo(raw)).toBe('/');
		},
	);

	it.each(['/', '/chat/one', '/chat/one?focus=latest#message'])(
		'preserves the local path %s',
		(raw) => {
			expect(safeLoginReturnTo(raw)).toBe(raw);
		},
	);
});
