import { describe, expect, it } from 'vitest';
import { GitHistoryComparisonSelectionState } from '$lib/git/history/git-history-comparison-selection.svelte.js';

describe('GitHistoryComparisonSelectionState', () => {
	it('collects a from/to pair and clears it after consumption', () => {
		const selection = new GitHistoryComparisonSelectionState();
		selection.begin();
		selection.select('older');
		selection.select('newer');

		expect(selection.take()).toEqual({
			fromRevision: 'older',
			toKind: 'revision',
			toRevision: 'newer',
		});
		expect(selection.active).toBe(false);
		expect(selection.from).toBeNull();
		expect(selection.to).toBeNull();
	});

	it('supports slot replacement and rejects incomplete selections', () => {
		const selection = new GitHistoryComparisonSelectionState();
		selection.begin();
		selection.select('old');
		selection.setSlot('from');
		selection.select('older');

		expect(selection.take()).toBeNull();
		expect(selection.active).toBe(true);
		selection.select('new');
		expect(selection.take()?.fromRevision).toBe('older');
	});

	it('cancel clears all range state', () => {
		const selection = new GitHistoryComparisonSelectionState();
		selection.begin();
		selection.select('old');
		selection.cancel();

		expect(selection.active).toBe(false);
		expect(selection.slot).toBe('from');
		expect(selection.from).toBeNull();
		expect(selection.to).toBeNull();
	});
});
