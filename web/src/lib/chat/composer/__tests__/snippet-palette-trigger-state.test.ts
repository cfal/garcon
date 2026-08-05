import { describe, expect, it } from 'vitest';
import { SnippetPaletteTriggerState } from '../snippet-palette-trigger-state.svelte.js';

function trigger(start = 0) {
	return { start, end: start + 4, query: 'go' };
}

function source(start = 0, suffix = 'go') {
	return `${'x'.repeat(start)};;${suffix}`;
}

describe('SnippetPaletteTriggerState', () => {
	it('opens for a detected trigger and preserves it while hidden', () => {
		const palette = new SnippetPaletteTriggerState();

		palette.updateDetectedTrigger(trigger(3), source(3));
		palette.hide();

		expect(palette.isOpen).toBe(false);
		expect(palette.trigger).toEqual(trigger(3));
		expect(palette.initialQuery).toBe('go');
	});

	it('suppresses a dismissed occurrence until its prefix is removed', () => {
		const palette = new SnippetPaletteTriggerState();

		palette.updateDetectedTrigger(trigger(3), source(3));
		palette.dismiss();
		palette.updateDetectedTrigger({ ...trigger(3), end: 9, query: 'gone' }, source(3, 'gone'));
		expect(palette.isOpen).toBe(false);

		palette.updateDetectedTrigger(null, `${source(3, 'gone')} `);
		palette.updateDetectedTrigger(trigger(3), source(3));
		expect(palette.isOpen).toBe(false);

		palette.updateDetectedTrigger(null, `${'x'.repeat(3)};`);
		palette.updateDetectedTrigger(trigger(3), source(3));
		expect(palette.isOpen).toBe(true);
	});

	it('does not discard an inline dismissal when a menu-opened palette closes', () => {
		const palette = new SnippetPaletteTriggerState();

		palette.updateDetectedTrigger(trigger(3), source(3));
		palette.dismiss();
		palette.openFromMenu();
		palette.dismiss();
		palette.updateDetectedTrigger(trigger(3), source(3));

		expect(palette.isOpen).toBe(false);
	});

	it('resets dismissals when the composer identity changes', () => {
		const palette = new SnippetPaletteTriggerState();

		palette.updateDetectedTrigger(trigger(3), source(3));
		palette.dismiss();
		palette.reset();
		palette.updateDetectedTrigger(trigger(3), source(3));

		expect(palette.isOpen).toBe(true);
	});
});
