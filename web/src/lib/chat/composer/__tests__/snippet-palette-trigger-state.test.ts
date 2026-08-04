import { describe, expect, it } from 'vitest';
import { SnippetPaletteTriggerState } from '../snippet-palette-trigger-state.svelte.js';

function trigger(start = 0) {
	return { start, end: start + 4, query: 'go' };
}

describe('SnippetPaletteTriggerState', () => {
	it('opens for a detected trigger and preserves it while hidden', () => {
		const palette = new SnippetPaletteTriggerState();

		palette.updateDetectedTrigger(trigger(3));
		palette.hide();

		expect(palette.isOpen).toBe(false);
		expect(palette.trigger).toEqual(trigger(3));
		expect(palette.initialQuery).toBe('go');
	});

	it('suppresses a dismissed occurrence until detection clears', () => {
		const palette = new SnippetPaletteTriggerState();

		palette.updateDetectedTrigger(trigger(3));
		palette.dismiss();
		palette.updateDetectedTrigger({ ...trigger(3), end: 6, query: 'gone' });
		expect(palette.isOpen).toBe(false);

		palette.updateDetectedTrigger(null);
		palette.updateDetectedTrigger(trigger(3));
		expect(palette.isOpen).toBe(true);
	});

	it('does not discard an inline dismissal when a menu-opened palette closes', () => {
		const palette = new SnippetPaletteTriggerState();

		palette.updateDetectedTrigger(trigger(3));
		palette.dismiss();
		palette.openFromMenu();
		palette.dismiss();
		palette.updateDetectedTrigger(trigger(3));

		expect(palette.isOpen).toBe(false);
	});

	it('resets dismissals when the composer identity changes', () => {
		const palette = new SnippetPaletteTriggerState();

		palette.updateDetectedTrigger(trigger(3));
		palette.dismiss();
		palette.reset();
		palette.updateDetectedTrigger(trigger(3));

		expect(palette.isOpen).toBe(true);
	});
});
