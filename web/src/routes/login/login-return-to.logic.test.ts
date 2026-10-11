import { describe, expect, it } from 'vitest';
import { safeLoginReturnTo } from './login-return-to';

describe('safeLoginReturnTo', () => {
	it.each([
		null,
		'',
		'chat/one',
		'//example.com',
		'/\\example.com',
		'/\t/example.com',
		'/\n/example.com',
		'/..//example.com',
	])('falls back to the app root for %j', (raw) => {
		expect(safeLoginReturnTo(raw)).toBe('/');
	});

	it.each(['/../chat/one', '/%2e%2e/chat/one', '/a/../../chat/one'])(
		'normalizes traversal before mounting %s',
		(raw) => expect(safeLoginReturnTo(raw)).toBe('/chat/one'),
	);

	it.each(['/', '/chat/one', '/chat/one?focus=latest#message'])(
		'preserves the local path %s',
		(raw) => {
			expect(safeLoginReturnTo(raw)).toBe(raw);
		},
	);
});
