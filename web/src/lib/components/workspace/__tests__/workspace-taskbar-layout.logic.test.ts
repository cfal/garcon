import { describe, expect, it } from 'vitest';
import {
	resolveCenteredTaskbarCapacity,
	selectVisibleTaskbarSurfaceIds,
} from '../workspace-taskbar-layout';

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

	it('keeps the active task when the pinned task no longer fits', () => {
		expect(
			selectVisibleTaskbarSurfaceIds({
				order,
				activeId: 'terminal:1',
				pinnedIds: ['singleton:chat'],
				availableWidth: 100,
				widths,
				gap: 2,
			}),
		).toEqual(['terminal:1']);
	});

	it('keeps an oversized active task so its rendered trigger can truncate', () => {
		expect(
			selectVisibleTaskbarSurfaceIds({
				order,
				activeId: 'singleton:files',
				pinnedIds: ['singleton:chat'],
				availableWidth: 40,
				widths,
				gap: 2,
			}),
		).toEqual(['singleton:files']);
	});

	it('moves every task into the menu when the centered rail has no capacity', () => {
		expect(
			selectVisibleTaskbarSurfaceIds({
				order,
				activeId: 'singleton:files',
				pinnedIds: ['singleton:chat'],
				availableWidth: 0,
				widths,
				gap: 2,
			}),
		).toEqual([]);
	});
});

describe('resolveCenteredTaskbarCapacity', () => {
	it('reserves the larger start region on both sides', () => {
		expect(
			resolveCenteredTaskbarCapacity({
				containerWidth: 500,
				startWidth: 110,
				endWidth: 82,
				regionGap: 6,
				railChromeWidth: 6,
			}),
		).toEqual({
			railWidth: 268,
			contentWidth: 262,
		});
	});

	it('reserves the larger end region on both sides', () => {
		expect(
			resolveCenteredTaskbarCapacity({
				containerWidth: 500,
				startWidth: 72,
				endWidth: 100,
				regionGap: 6,
				railChromeWidth: 6,
			}),
		).toEqual({
			railWidth: 288,
			contentWidth: 282,
		});
	});

	it('clamps rail and content capacity at zero', () => {
		expect(
			resolveCenteredTaskbarCapacity({
				containerWidth: 120,
				startWidth: 80,
				endWidth: 96,
				regionGap: 6,
				railChromeWidth: 6,
			}),
		).toEqual({
			railWidth: 0,
			contentWidth: 0,
		});
	});
});
