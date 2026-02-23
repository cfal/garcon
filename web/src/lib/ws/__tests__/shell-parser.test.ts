import { describe, it, expect } from 'vitest';
import { parseShellServerMessage } from '$lib/types/shell';

describe('parseShellServerMessage', () => {
	it('parses an output message', () => {
		const msg = parseShellServerMessage({ type: 'output', data: 'hello' });
		expect(msg).toEqual({ type: 'output', data: 'hello' });
	});

	it('parses an exit message with exitCode', () => {
		const msg = parseShellServerMessage({ type: 'exit', exitCode: 0 });
		expect(msg).toEqual({ type: 'exit', exitCode: 0, signal: undefined });
	});

	it('parses an exit message with exitCode and signal', () => {
		const msg = parseShellServerMessage({ type: 'exit', exitCode: 1, signal: 'SIGTERM' });
		expect(msg).toEqual({ type: 'exit', exitCode: 1, signal: 'SIGTERM' });
	});

	it('defaults exitCode to 0 when not provided', () => {
		const msg = parseShellServerMessage({ type: 'exit' });
		expect(msg).toEqual({ type: 'exit', exitCode: 0, signal: undefined });
	});

	it('parses an error message', () => {
		const msg = parseShellServerMessage({ type: 'error', message: 'fail' });
		expect(msg).toEqual({ type: 'error', message: 'fail' });
	});

	it('returns null for unknown type', () => {
		expect(parseShellServerMessage({ type: 'unknown' })).toBeNull();
	});

	it('returns null for null input', () => {
		expect(parseShellServerMessage(null)).toBeNull();
	});

	it('returns null for undefined input', () => {
		expect(parseShellServerMessage(undefined)).toBeNull();
	});

	it('returns null for non-object input', () => {
		expect(parseShellServerMessage('not an object')).toBeNull();
	});

	it('returns null when type field is missing', () => {
		expect(parseShellServerMessage({ data: 'no type' })).toBeNull();
	});

	it('returns null for output message missing data field', () => {
		expect(parseShellServerMessage({ type: 'output' })).toBeNull();
	});

	it('returns null for removed auth_url message shape', () => {
		expect(parseShellServerMessage({ type: 'auth_url', url: 'https://example.com' })).toBeNull();
	});

	it('returns null for error message missing message field', () => {
		expect(parseShellServerMessage({ type: 'error' })).toBeNull();
	});
});
