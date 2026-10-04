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
				availableWidth: 360,
				widths: new Map(order.map((surfaceId) => [surfaceId, 100])),
				gap: 2,
				trailingReservedWidths,
			}),
		).toEqual({ visibleIds: order, labelMode: 'truncated' });
	});

	it('keeps the active tab and earliest tabs when even icons overflow', () => {
		expect(
			resolveWindowTabPresentation({
				order,
				activeId: 'terminal:1',
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
				availableWidth: 20,
				widths,
				gap: 2,
			}),
		).toEqual({ visibleIds: [], labelMode: 'icon-only' });
	});

	describe('active title priority', () => {
		const activeTitleId = order[0]!;
		const input = {
			order,
			activeId: activeTitleId,
			activeTitleId,
			widths: new Map(order.map((id) => [id, 160])),
			gap: 2,
			trailingReservedWidths: new Map(
				order.map((id) => [id, WINDOW_TAB_INLINE_CLOSE_RESERVED_WIDTH]),
			),
		};

		it.each([
			[700, 'full'],
			[358, 'truncated'],
		] as const)('preserves the existing %s px labeled stage', (availableWidth, labelMode) => {
			expect(resolveWindowTabPresentation({ ...input, availableWidth })).toEqual({
				visibleIds: order,
				labelMode,
			});
		});

		it.each([
			[178, order],
			[177, order.slice(0, 3)],
			[118, order.slice(0, 2)],
			[117, [activeTitleId]],
			[88, [activeTitleId]],
		])('retains the title and fitting icons at %s px', (availableWidth, visibleIds) => {
			expect(resolveWindowTabPresentation({ ...input, availableWidth })).toEqual({
				visibleIds,
				labelMode: 'active-title',
				activeTitleId,
			});
		});

		it.each([
			[87, order.slice(0, 2)],
			[28, [activeTitleId]],
			[27, []],
		])('falls back to icons and the menu at %s px', (availableWidth, visibleIds) => {
			expect(resolveWindowTabPresentation({ ...input, availableWidth })).toEqual({
				visibleIds,
				labelMode: 'icon-only',
			});
		});

		it('preserves tab order when the active title is last', () => {
			const reordered = [...order.slice(1), activeTitleId];
			expect(
				resolveWindowTabPresentation({ ...input, order: reordered, availableWidth: 148 }),
			).toEqual({
				visibleIds: [order[1], order[2], activeTitleId],
				labelMode: 'active-title',
				activeTitleId,
			});
		});

		it('reserves scaled close controls and icon widths at the exact boundary', () => {
			const scaled = {
				...input,
				iconWidth: 34,
				trailingReservedWidths: new Map([[activeTitleId, 30]]),
			};
			expect(resolveWindowTabPresentation({ ...scaled, availableWidth: 166 })).toEqual({
				visibleIds: order.slice(0, 3),
				labelMode: 'active-title',
				activeTitleId,
			});
			expect(resolveWindowTabPresentation({ ...scaled, availableWidth: 165 })).toEqual({
				visibleIds: order.slice(0, 2),
				labelMode: 'active-title',
				activeTitleId,
			});
		});

		it('does not reserve a close control when none is present', () => {
			expect(
				resolveWindowTabPresentation({
					...input,
					trailingReservedWidths: undefined,
					availableWidth: 94,
				}),
			).toEqual({ visibleIds: order.slice(0, 2), labelMode: 'active-title', activeTitleId });
		});

		it.each([null, 'missing-tab', order[1]])('ignores an ineligible title %s', (candidate) => {
			expect(
				resolveWindowTabPresentation({
					...input,
					activeTitleId: candidate,
					availableWidth: 178,
				}),
			).toEqual({ visibleIds: order, labelMode: 'icon-only' });
		});

		it('keeps a short active title without altering the full-label measurement', () => {
			expect(
				resolveWindowTabPresentation({
					...input,
					widths: new Map([...input.widths, [activeTitleId, 70]]),
					availableWidth: 118,
				}),
			).toEqual({ visibleIds: order.slice(0, 2), labelMode: 'active-title', activeTitleId });
		});

		it('waits for complete measurements before applying title priority', () => {
			expect(
				resolveWindowTabPresentation({
					...input,
					widths: new Map([[activeTitleId, 160]]),
					availableWidth: 118,
				}),
			).toEqual({ visibleIds: order, labelMode: 'full' });
		});
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
