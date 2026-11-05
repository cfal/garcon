import { describe, expect, it } from 'vitest';
import { UserMessage } from '$shared/chat-types';
import { DisplayBodyStore } from '../display-body-store.js';

const identity = { serverInstanceId: 'instance', chatId: 'chat', transcriptViewId: 'view' };
const body = (ordinal: number) => ({ ordinal, message: new UserMessage('2026-01-01T00:00:00.000Z', 'Generic text'), submissionClientMessageId: null });

describe('display body leases', () => {
	it('deduplicates immutable bodies and releases only after the final owner leaves', () => {
		const store = new DisplayBodyStore(), first = {}, second = {};
		store.resetInstance(identity.serverInstanceId);
		store.retain(first, identity, [1, 2]);
		store.put(identity, [body(1), body(2)]);
		store.retain(second, identity, [2]);
		store.put(identity, [body(2)]);
		expect(store.count).toBe(2);
		store.release(first);
		expect(store.get(identity, 1)).toBeUndefined();
		expect(store.get(identity, 2)).toBeDefined();
		store.release(second);
		expect(store.estimatedBytes).toBe(0);
	});
	it('records protected budget exceptions and clears reused addresses on restart', () => {
		const store = new DisplayBodyStore({ count: 1, bytes: 1 }), owner = {};
		store.resetInstance(identity.serverInstanceId);
		store.retain(owner, identity, [1, 2]); store.put(identity, [body(1), body(2)]);
		expect(store.overBudget).toBe(true);
		store.resetInstance('new-instance');
		expect(store.count).toBe(0);
		expect(() => store.put(identity, [body(1)])).toThrow('Stale');
	});
	it('accounts parked leases separately while shared active addresses count once', () => {
		const store = new DisplayBodyStore({ count: 2, bytes: 10000 }), first = {}, second = {};
		store.resetInstance(identity.serverInstanceId);
		store.retain(first, identity, [1, 2]); store.put(identity, [body(1), body(2)]);
		store.retain(second, identity, [2, 3]); store.put(identity, [body(3)]);
		expect(store.activeOverBudget).toBe(true);
		store.setParked(first, true);
		expect(store.activeOverBudget).toBe(false);
		expect(store.overBudget).toBe(true);
		store.setParked(first, false);
		expect(store.activeOverBudget).toBe(true);
	});
	it('counts oversized rows independently of the shared budget', () => {
		const store = new DisplayBodyStore(), owner = {};
		store.resetInstance(identity.serverInstanceId); store.retain(owner, identity, [1]);
		store.put(identity, [{ ...body(1), message: new UserMessage('2026-01-01T00:00:00.000Z', 'x'.repeat(1500000)) }]);
		expect(store.metrics.oversized).toBe(1);
		expect(store.usage(owner).oversized).toBe(1);
		expect(store.activeOverBudget).toBe(false);
	});
});
