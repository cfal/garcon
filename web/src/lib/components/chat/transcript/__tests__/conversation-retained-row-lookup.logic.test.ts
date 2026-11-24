import { describe, expect, it } from 'vitest';
import { ConversationRetainedRowLookup } from '../conversation-retained-row-lookup.js';

describe('retained row membership', () => {
	it('matches the current raw window through prepends, rolling, echo and view replacement', () => {
		const lookup = new ConversationRetainedRowLookup();
		const ids = ['v:1', 'v:7', 'v:9', 'optimistic:x', 'notice', 'other:1'];
		for (const window of [
			['v:7', 'optimistic:x', 'v:9', 'notice'],
			['v:1', 'v:7', 'optimistic:x', 'v:9', 'notice'],
			['v:7', 'v:9', 'v:10'],
			['v:1', 'v:7', 'v:9'],
			['other:1'], [],
		]) {
			const actual = lookup.forRows(window.map(id => ({ id })));
			expect(ids.map(id => actual.has(id))).toEqual(ids.map(id => window.includes(id)));
		}
	});

	it('verifies warm positions, shares one fallback per window, and forgets unqueried rows', () => {
		const lookup = new ConversationRetainedRowLookup();
		let reads = 0;
		const rows = Array.from({ length: 100 }, (_, i) => ({ get id() { reads++; return 'v:' + i; } }));
		const cold = lookup.forRows(rows);
		expect(reads).toBe(0);
		expect([cold.has('v:3'), cold.has('v:40'), cold.has('missing')]).toEqual([true, true, false]);
		expect(reads).toBe(100);
		reads = 0;
		const warm = lookup.forRows([...rows, { id: 'v:100' }]);
		expect([warm.has('v:40'), warm.has('v:40')]).toEqual([true, true]);
		expect(reads).toBe(1);
		reads = 0;
		expect(lookup.forRows(rows).has('v:3')).toBe(true);
		expect(reads).toBe(100);
		expect(lookup.clear().has('v:3')).toBe(false);
		reads = 0;
		expect(lookup.forRows(rows).has('v:3')).toBe(true);
		expect(reads).toBe(100);
	});
});
