import { describe, expect, it } from 'vitest';
import {
	resolveWindowTabCapacity,
	resolveWindowTabPresentation,
	WINDOW_TAB_INLINE_CLOSE_RESERVED_WIDTH,
} from '../workspace-window-tab-layout';

const order = ['chat-view:window-main', 'singleton:git', 'singleton:files', 'terminal:1'];
const widths = new Map(order.map((surfaceId) => [surfaceId, 80]));

describe('resolveWindowTabPresentation', () => {
	it('uses full labels while their natural widths fit', () => {
		expect(
			resolveWindowTabPresentation({
				order,
				activeId: 'singleton:files',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 400,
				widths,
				gap: 2,
			}),
		).toEqual({ visibleIds: order, labelMode: 'full' });
	});

	it('keeps every tab and truncates labels only after natural widths stop fitting', () => {
		expect(
			resolveWindowTabPresentation({
				order,
				activeId: 'singleton:files',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 280,
				widths,
				gap: 2,
			}),
		).toEqual({ visibleIds: order, labelMode: 'truncated' });
	});

	it('switches every tab to icon-only before hiding any tab', () => {
		expect(
			resolveWindowTabPresentation({
				order,
				activeId: 'terminal:1',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 120,
				widths,
				gap: 2,
			}),
		).toEqual({ visibleIds: order, labelMode: 'icon-only' });
	});

	it('reserves close-control width before choosing truncated labels', () => {
		const trailingReservedWidths = new Map(
			order.map((surfaceId) => [surfaceId, WINDOW_TAB_INLINE_CLOSE_RESERVED_WIDTH]),
		);

		expect(
			resolveWindowTabPresentation({
				order,
				activeId: 'singleton:files',
				pinnedIds: [],
				availableWidth: 350,
				widths: new Map(order.map((surfaceId) => [surfaceId, 100])),
				gap: 2,
				trailingReservedWidths,
			}),
		).toEqual({ visibleIds: order, labelMode: 'icon-only' });

		expect(
			resolveWindowTabPresentation({
				order,
				activeId: 'singleton:files',
				pinnedIds: [],
				availableWidth: 360,
				widths: new Map(order.map((surfaceId) => [surfaceId, 100])),
				gap: 2,
				trailingReservedWidths,
			}),
		).toEqual({ visibleIds: order, labelMode: 'truncated' });
	});

	it('keeps pinned and active tabs first when even icons overflow', () => {
		expect(
			resolveWindowTabPresentation({
				order,
				activeId: 'terminal:1',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 90,
				widths,
				gap: 2,
			}),
		).toEqual({
			visibleIds: ['chat-view:window-main', 'singleton:git', 'terminal:1'],
			labelMode: 'icon-only',
		});
	});

	it('waits for every measured width before changing label presentation', () => {
		expect(
			resolveWindowTabPresentation({
				order,
				activeId: 'terminal:1',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 100,
				widths: new Map([['chat-view:window-main', 80]]),
				gap: 2,
			}),
		).toEqual({ visibleIds: order, labelMode: 'full' });
	});

	it('moves every tab into the menu when not even one icon fits', () => {
		expect(
			resolveWindowTabPresentation({
				order,
				activeId: 'singleton:files',
				pinnedIds: ['chat-view:window-main'],
				availableWidth: 20,
				widths,
				gap: 2,
			}),
		).toEqual({ visibleIds: [], labelMode: 'icon-only' });
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
