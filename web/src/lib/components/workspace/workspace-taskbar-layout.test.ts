import { describe, expect, it } from 'vitest';
import { selectVisibleTaskbarSurfaceIds } from './workspace-taskbar-layout';

const order = ['singleton:chat', 'singleton:git', 'singleton:files', 'terminal:1'];
const widths = new Map(order.map((surfaceId) => [surfaceId, 80]));

describe('selectVisibleTaskbarSurfaceIds', () => {
	it('keeps every task visible while the rail has capacity', () => {
		expect(
			selectVisibleTaskbarSurfaceIds({
				order,
				activeId: 'singleton:files',
				pinnedIds: ['singleton:chat'],
				availableWidth: 400,
				widths,
				gap: 2,
			}),
		).toEqual(order);
	});

	it('keeps pinned and active tasks visible before overflowing earlier inactive tasks', () => {
		expect(
			selectVisibleTaskbarSurfaceIds({
				order,
				activeId: 'terminal:1',
				pinnedIds: ['singleton:chat'],
				availableWidth: 244,
				widths,
				gap: 2,
			}),
		).toEqual(['singleton:chat', 'singleton:git', 'terminal:1']);
	});

	it('waits for every measured width before hiding tasks', () => {
		expect(
			selectVisibleTaskbarSurfaceIds({
				order,
				activeId: 'terminal:1',
				pinnedIds: ['singleton:chat'],
				availableWidth: 100,
				widths: new Map([['singleton:chat', 80]]),
				gap: 2,
			}),
		).toEqual(order);
	});
});
