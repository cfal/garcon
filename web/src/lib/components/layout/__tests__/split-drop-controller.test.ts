import { describe, expect, it } from 'vitest';
import { resolveDropZone, SPLIT_DROP_ZONES } from '../split-drop-controller.svelte';

const rect = {
	left: 100,
	top: 200,
	width: 400,
	height: 300,
};

describe('resolveDropZone', () => {
	it('maps pointer positions near each edge to a split zone', () => {
		expect(resolveDropZone(rect, 300, 210)).toBe('top');
		expect(resolveDropZone(rect, 300, 490)).toBe('bottom');
		expect(resolveDropZone(rect, 110, 350)).toBe('left');
		expect(resolveDropZone(rect, 490, 350)).toBe('right');
	});

	it('uses center for positions outside the edge bands', () => {
		expect(resolveDropZone(rect, 300, 350)).toBe('center');
	});
});

describe('SPLIT_DROP_ZONES', () => {
	it('defines one presentation entry per drop zone', () => {
		expect(SPLIT_DROP_ZONES.map((entry) => entry.zone)).toEqual([
			'top',
			'bottom',
			'left',
			'right',
			'center',
		]);
	});
});
