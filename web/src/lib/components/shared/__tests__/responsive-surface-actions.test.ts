import { describe, expect, test } from 'vitest';
import { selectVisibleSurfaceActionIds } from '../responsive-surface-actions.js';

const actions = [
	{ id: 'save', priority: 0 },
	{ id: 'refresh', priority: 2 },
	{ id: 'open', priority: 1 },
];
const widths = new Map([
	['save', 72],
	['refresh', 32],
	['open', 80],
]);

describe('selectVisibleSurfaceActionIds', () => {
	test('keeps every action when the measured rail fits', () => {
		expect(
			selectVisibleSurfaceActionIds({
				actions,
				availableWidth: 200,
				widths,
				overflowButtonWidth: 32,
				gap: 4,
			}),
		).toEqual(new Set(['save', 'refresh', 'open']));
	});

	test('keeps the highest-priority actions and reserves overflow width', () => {
		expect(
			selectVisibleSurfaceActionIds({
				actions,
				availableWidth: 120,
				widths,
				overflowButtonWidth: 32,
				gap: 4,
			}),
		).toEqual(new Set(['save']));
	});

	test('waits for complete measurements before hiding actions', () => {
		expect(
			selectVisibleSurfaceActionIds({
				actions,
				availableWidth: 1,
				widths: new Map([['save', 72]]),
				overflowButtonWidth: 32,
				gap: 4,
			}),
		).toEqual(new Set(['save', 'refresh', 'open']));
	});
});
