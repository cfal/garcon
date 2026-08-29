import { describe, expect, it } from 'vitest';
import {
	resolveWindowTabCapacity,
	selectVisibleWindowTabIds,
} from '../workspace-window-tab-layout';

const order = ['chat-view:window-main', 'singleton:git', 'singleton:files', 'terminal:1'];
const widths = new Map(order.map((surfaceId) => [surfaceId, 80]));

describe('selectVisibleWindowTabIds', () => {
	it('keeps every task visible while the rail has capacity', () => {
		expect(
			selectVisibleWindowTabIds({
				order,
				activeId: 'singleton:files',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 400,
				widths,
				gap: 2,
			}),
		).toEqual(order);
	});

	it('keeps pinned and active tasks visible before overflowing earlier inactive tasks', () => {
		expect(
			selectVisibleWindowTabIds({
				order,
				activeId: 'terminal:1',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 244,
				widths,
				gap: 2,
			}),
		).toEqual(['chat-view:window-main', 'singleton:git', 'terminal:1']);
	});

	it('waits for every measured width before hiding tasks', () => {
		expect(
			selectVisibleWindowTabIds({
				order,
				activeId: 'terminal:1',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 100,
				widths: new Map([['chat-view:window-main', 80]]),
				gap: 2,
			}),
		).toEqual(order);
	});

	it('keeps the active task when the pinned task no longer fits', () => {
		expect(
			selectVisibleWindowTabIds({
				order,
				activeId: 'terminal:1',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 100,
				widths,
				gap: 2,
			}),
		).toEqual(['terminal:1']);
	});

	it('keeps an oversized active task so its rendered trigger can truncate', () => {
		expect(
			selectVisibleWindowTabIds({
				order,
				activeId: 'singleton:files',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 40,
				widths,
				gap: 2,
			}),
		).toEqual(['singleton:files']);
	});

	it('moves every task into the menu when the centered rail has no capacity', () => {
		expect(
			selectVisibleWindowTabIds({
				order,
				activeId: 'singleton:files',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 0,
				widths,
				gap: 2,
			}),
		).toEqual([]);
	});
});

describe('resolveWindowTabCapacity', () => {
	it('subtracts fixed actions and auxiliary content from the left-aligned rail', () => {
		expect(
			resolveWindowTabCapacity({
				containerWidth: 500,
				actionsWidth: 82,
				auxiliaryWidth: 110,
				gap: 6,
				railChromeWidth: 6,
			}),
		).toEqual({
			railWidth: 302,
			contentWidth: 296,
		});
	});

	it('uses the actual action width without symmetric centering', () => {
		expect(
			resolveWindowTabCapacity({
				containerWidth: 500,
				actionsWidth: 100,
				auxiliaryWidth: 72,
				gap: 6,
				railChromeWidth: 6,
			}),
		).toEqual({
			railWidth: 322,
			contentWidth: 316,
		});
	});

	it('clamps rail and content capacity at zero', () => {
		expect(
			resolveWindowTabCapacity({
				containerWidth: 120,
				actionsWidth: 96,
				auxiliaryWidth: 80,
				gap: 6,
				railChromeWidth: 6,
			}),
		).toEqual({
			railWidth: 0,
			contentWidth: 0,
		});
	});
});
