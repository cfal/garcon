import { describe, expect, it } from 'vitest';
import {
	SPLIT_PANE_TEXT_SCALE_DEFAULT,
	SPLIT_PANE_TEXT_SCALE_FOUR_PANES,
	SPLIT_PANE_TEXT_SCALE_TWO_PANES,
	getSplitPaneTextScale,
} from '../split-pane-text-scale';

describe('getSplitPaneTextScale', () => {
	it('keeps normal scale outside multi-pane layouts', () => {
		expect(getSplitPaneTextScale(0)).toBe(SPLIT_PANE_TEXT_SCALE_DEFAULT);
		expect(getSplitPaneTextScale(1)).toBe(SPLIT_PANE_TEXT_SCALE_DEFAULT);
	});

	it('uses the compact scale for two and three panes', () => {
		expect(getSplitPaneTextScale(2)).toBe(SPLIT_PANE_TEXT_SCALE_TWO_PANES);
		expect(getSplitPaneTextScale(3)).toBe(SPLIT_PANE_TEXT_SCALE_TWO_PANES);
	});

	it('uses the dense scale for four or more panes', () => {
		expect(getSplitPaneTextScale(4)).toBe(SPLIT_PANE_TEXT_SCALE_FOUR_PANES);
		expect(getSplitPaneTextScale(5)).toBe(SPLIT_PANE_TEXT_SCALE_FOUR_PANES);
	});
});
