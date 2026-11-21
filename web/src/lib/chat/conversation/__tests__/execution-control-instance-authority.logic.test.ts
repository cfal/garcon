import { describe, expect, it, vi } from 'vitest';
import { ExecutionControlInstanceAuthority } from '../execution-control-instance-authority.js';

describe('ExecutionControlInstanceAuthority', () => {
	it('orders live socket observations without confirming or superseding ambiguous instances', () => {
		const clock = vi.spyOn(performance, 'now').mockReturnValue(20);
		try {
			const authority = new ExecutionControlInstanceAuthority();
			expect(authority.acceptsSocketObservation('first', 10)).toBe(true);
			authority.classifyNonAuthoritativeInstance('current');
			expect(authority.acceptsSocketObservation('unseen', 10)).toBe(false);
			expect(authority.acceptsSocketObservation('unseen', 20)).toBe(false);
			expect(authority.acceptsSocketObservation('current', 10)).toBe(true);
			expect(authority.acceptsSocketObservation('unseen', 21)).toBe(true);
			expect(authority.isSocketInstanceConfirmed('unseen')).toBe(false);
			expect(authority.classifyNonAuthoritativeInstance('current')).toEqual({ kind: 'current' });
			clock.mockReturnValue(30);
			expect(authority.confirmSocketInstance('unseen', 25)).toEqual({ kind: 'replace' });
			expect(authority.acceptsSocketObservation('unseen', 10)).toBe(true);
		} finally {
			clock.mockRestore();
		}
	});

	it('requires a later probe to replace an instance observed during the query', () => {
		const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
		try {
			const authority = new ExecutionControlInstanceAuthority();
			authority.confirmSocketInstance('first', 10);
			authority.markSocketDisconnected();
			clock.mockReturnValue(20);
			authority.classifyNonAuthoritativeInstance('second');
			expect(authority.confirmSocketInstance('first', 10)).toBeNull();
			expect(authority.confirmSocketInstance('first', 20)).toBeNull();
			expect(authority.isSocketInstanceConfirmed('first')).toBe(false);
			expect(authority.classifyNonAuthoritativeInstance('second')).toEqual({ kind: 'current' });
			expect(authority.confirmSocketInstance('second', 10)).toEqual({ kind: 'current' });
			clock.mockReturnValue(30);
			expect(authority.confirmSocketInstance('first', 30)).toEqual({ kind: 'replace' });
		} finally {
			clock.mockRestore();
		}
	});

	it('fences delayed unseen responses while accepting the current process and fresh fallback requests', () => {
		const authority = new ExecutionControlInstanceAuthority();
		authority.confirmSocketInstance('first');
		const oldResponse = authority.captureResponseFence();
		authority.markSocketDisconnected();
		authority.classifyNonAuthoritativeInstance('third');
		expect(oldResponse('second')).toBe(false);
		expect(oldResponse('third')).toBe(true);
		expect(authority.captureResponseFence()('fourth')).toBe(true);
	});

	it('does not revive a response fence when the same socket identity is reauthorized', () => {
		const authority = new ExecutionControlInstanceAuthority();
		authority.confirmSocketInstance('first');
		const oldResponse = authority.captureResponseFence();
		authority.markSocketDisconnected();
		authority.confirmSocketInstance('first');
		authority.markSocketDisconnected();
		expect(oldResponse('second')).toBe(false);
		expect(oldResponse('first')).toBe(true);
	});

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
