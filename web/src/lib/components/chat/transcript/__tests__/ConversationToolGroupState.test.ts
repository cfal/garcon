import { describe, expect, it } from 'vitest';
import { ConversationToolGroupState } from '../ConversationToolGroupState.svelte.js';

describe('ConversationToolGroupState', () => {
	it('keeps expansion across appends, virtual unmounts, and overlapping regrouping', () => {
		const groups = new ConversationToolGroupState();
		groups.reconcile('surface-1', new Set(['a', 'b']));
		groups.setExpanded(['a', 'b'], true);
		const expanded = groups.expandedMemberIds;
		groups.reconcile('surface-1', new Set(['a', 'b', 'c']));
		expect(groups.expandedMemberIds).toBe(expanded);
		groups.setExpanded(['a', 'b', 'c'], true);
		expect([...groups.expandedMemberIds]).toEqual(['a', 'b', 'c']);
		groups.reconcile('surface-1', new Set(['b', 'c', 'd']));
		expect([...groups.expandedMemberIds]).toEqual(['b', 'c']);
	});

	it('resets on surface replacement and preserves identity for no-op updates', () => {
		const groups = new ConversationToolGroupState();
		groups.reconcile('surface-1', new Set(['a']));
		groups.setExpanded(['a'], true);
		const expanded = groups.expandedMemberIds;
		groups.setExpanded(['a'], true);
		expect(groups.expandedMemberIds).toBe(expanded);
		groups.reconcile('surface-2', new Set(['a']));
		expect(groups.expandedMemberIds.size).toBe(0);
	});
});
