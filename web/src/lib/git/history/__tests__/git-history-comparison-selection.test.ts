import { describe, expect, it } from 'vitest';
import { GitHistoryComparisonSelectionState } from '$lib/git/history/git-history-comparison-selection.svelte.js';

describe('GitHistoryComparisonSelectionState', () => {
	it('collects a from/to pair without discarding the editable selection', () => {
		const selection = new GitHistoryComparisonSelectionState();
		selection.begin();
		selection.select('older');
		selection.select('newer');

		expect(selection.comparison()).toEqual({
			fromRevision: 'older',
			toKind: 'revision',
			toRevision: 'newer',
		});
		expect(selection.active).toBe(true);
		expect(selection.from).toBe('older');
		expect(selection.to).toBe('newer');
	});

	it('supports slot replacement and rejects incomplete selections', () => {
		const selection = new GitHistoryComparisonSelectionState();
		selection.begin();
		selection.select('old');
		selection.setSlot('from');
		selection.select('older');

		expect(selection.comparison()).toBeNull();
		expect(selection.active).toBe(true);
		selection.select('new');
		expect(selection.comparison()?.fromRevision).toBe('older');
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
