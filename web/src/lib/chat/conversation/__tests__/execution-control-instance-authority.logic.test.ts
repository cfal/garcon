import { describe, expect, it } from 'vitest';
import { ExecutionControlInstanceAuthority } from '../execution-control-instance-authority.js';

describe('ExecutionControlInstanceAuthority', () => {
	it('treats live input as provisional until the current socket confirms it', () => {
		const authority = new ExecutionControlInstanceAuthority();

		expect(authority.classifyNonAuthoritativeInstance('server-a')).toEqual({ kind: 'replace' });
		expect(authority.isSocketInstanceConfirmed('server-a')).toBe(false);
		expect(authority.classifyNonAuthoritativeInstance('server-a')).toEqual({ kind: 'current' });
		expect(authority.confirmSocketInstance('server-a')).toEqual({ kind: 'current' });
		expect(authority.isSocketInstanceConfirmed('server-a')).toBe(true);
		expect(authority.classifyNonAuthoritativeInstance('server-b')).toMatchObject({
			kind: 'reject',
			reason: 'confirmed-socket-mismatch',
			currentInstanceId: 'server-a',
			confirmedSocketInstanceId: 'server-a',
		});
	});

	it('retains superseded identities across socket outages', () => {
		const authority = new ExecutionControlInstanceAuthority();
		authority.confirmSocketInstance('server-a');
		authority.markSocketDisconnected();
		expect(authority.isSocketInstanceConfirmed('server-a')).toBe(false);
		expect(authority.classifyNonAuthoritativeInstance('server-b')).toEqual({ kind: 'replace' });
		expect(authority.classifyNonAuthoritativeInstance('server-a')).toMatchObject({
			kind: 'reject',
			reason: 'superseded-instance',
		});

		authority.confirmSocketInstance('server-b');
		authority.markSocketDisconnected();
		expect(authority.classifyNonAuthoritativeInstance('server-a')).toMatchObject({
			kind: 'reject',
			reason: 'superseded-instance',
		});
	});

	it('lets correlated socket authority reauthorize a retired identity', () => {
		const authority = new ExecutionControlInstanceAuthority();
		authority.confirmSocketInstance('server-a');
		authority.markSocketDisconnected();
		authority.classifyNonAuthoritativeInstance('server-b');

		expect(authority.confirmSocketInstance('server-a')).toEqual({ kind: 'replace' });
		expect(authority.classifyNonAuthoritativeInstance('server-a')).toEqual({ kind: 'current' });
		expect(authority.classifyNonAuthoritativeInstance('server-b')).toMatchObject({
			kind: 'reject',
			reason: 'confirmed-socket-mismatch',
		});
	});

	it('allows unseen fallback instances while unconfirmed and preserves reauthorization', () => {
		const authority = new ExecutionControlInstanceAuthority();
		expect(authority.classifyNonAuthoritativeInstance('server-d')).toEqual({ kind: 'replace' });
		expect(authority.classifyNonAuthoritativeInstance('server-c')).toEqual({ kind: 'replace' });
		expect(authority.classifyNonAuthoritativeInstance('server-b')).toEqual({ kind: 'replace' });

		expect(authority.confirmSocketInstance('server-d')).toEqual({ kind: 'replace' });
		expect(authority.classifyNonAuthoritativeInstance('server-c')).toMatchObject({
			kind: 'reject',
			reason: 'confirmed-socket-mismatch',
		});
	});
});
