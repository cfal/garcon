import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVirtualListHarness } from './virtual-list-test-harness';
import type { VirtualMeasurementAnchor } from '../virtual-list-types';

const active: Array<ReturnType<typeof createVirtualListHarness>> = [];

function harness(options?: Parameters<typeof createVirtualListHarness>[0]) {
	const created = createVirtualListHarness(options);
	active.push(created);
	return created;
}

function readerHarness(
	estimates: Record<string, number>,
	{ viewportOffset, viewportSize = 200 }: { viewportOffset: number; viewportSize?: number },
) {
	const test = harness({ viewportSize, measurementAnchor: { kind: 'item', key: 'reader', viewportOffset } });
	test.controller.apply({
		kind: 'update',
		keys: Object.keys(estimates),
		estimates: Object.values(estimates),
		anchor: { kind: 'none' },
	});
	return test;
}

afterEach(() => {
	while (active.length > 0) active.pop()?.destroy();
});

describe('VirtualListController', () => {
	it('publishes a measured range and never observes its self-sized sizer', () => {
		const test = harness({ viewportSize: 60, overscan: 1 });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [30, 30, 30],
			anchor: { kind: 'none' },
		});
		expect(test.controller.snapshot.visibleRange).toEqual({ startIndex: 0, endIndex: 1 });
		expect(test.controller.snapshot.overscanRange).toEqual({ startIndex: 0, endIndex: 2 });
		expect(test.controller.snapshot.sizerSize).toBe(90);
		expect(test.environment.observer.observed.has(test.viewport)).toBe(true);
		expect(test.environment.observer.observed.has(test.sizer)).toBe(false);

		const first = test.mountItem('a', 40);
		test.mountItem('b', 20);
		expect(test.environment.observer.observedBoxes.get(test.viewport)).toBeUndefined();
		expect(test.environment.observer.observedBoxes.get(first.element)).toBe('border-box');
		test.environment.flushMicrotasks();
		expect(test.controller.measuredSize('a')).toBe(40);
		expect(test.controller.snapshot.positions.itemAt(1)?.start).toBe(40);
	});

	it('uses the initial viewport size until the DOM reports a positive size', () => {
		const test = harness({ viewportSize: 0, initialViewportSize: 60, overscan: 0 });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c', 'd'],
			estimates: [30, 30, 30, 30],
			anchor: { kind: 'none' },
		});

		expect(test.controller.snapshot.visibleRange).toEqual({ startIndex: 0, endIndex: 1 });
		test.mountItem('a', 5);
		test.environment.flushMicrotasks();
		expect(test.controller.measuredSize('a')).toBeUndefined();
		test.setPhysicalScrollTop(30);
		expect(test.controller.snapshot.visibleRange).toEqual({ startIndex: 1, endIndex: 2 });

		test.setViewportSize(60);
		test.environment.flushMicrotasks();
		expect(test.controller.measuredSize('a')).toBe(5);
	});

	it('keeps the first row pinned while initial measurements settle at the start', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [30, 30, 30],
			anchor: { kind: 'none' },
		});
		test.mountItem('a', 40);
		test.mountItem('b', 40);
		test.mountItem('c', 40);

		test.environment.flushMicrotasks();

		expect(test.viewport.scrollTop).toBe(0);
		expect(test.records.at(-1)).toMatchObject({
			source: 'mount',
			anchorIndex: 0,
			correction: 0,
			scrollWrites: 0,
		});
	});

	it('treats DOM bounds as provisional until the viewport is observed', () => {
		const test = harness({ viewportSize: 0, initialViewportSize: 60, overscan: 0 });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c', 'd'],
			estimates: [30, 30, 30, 30],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(150);

		test.controller.apply({
			kind: 'update',
			keys: ['earlier', 'a', 'b', 'c', 'd'],
			estimates: [30, 30, 30, 30, 30],
			anchor: { kind: 'item', key: 'b' },
		});
		test.environment.flushMicrotasks();

		expect(test.records.at(-1)).toMatchObject({
			source: 'items',
			redeemed: true,
			scrollWrites: 1,
		});
	});

	it('allows consumers to normalize measurements at DOM ingress', () => {
		const test = harness({
			measureElement: (_element, entry) => entry?.borderBoxSize[0]?.blockSize ?? 64,
		});
		test.controller.apply({
			kind: 'update',
			keys: ['a'],
			estimates: [32],
			anchor: { kind: 'none' },
		});
		const mounted = test.mountItem('a', 0);
		test.environment.flushMicrotasks();

		expect(test.controller.measuredSize('a')).toBe(64);
		test.environment.observer.emit(mounted.element, 48);
		expect(test.controller.measuredSize('a')).toBe(48);
	});

	it('keeps an item fixed through prepend while coasting and redeems after idle', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['b', 'c', 'd'],
			estimates: [40, 40, 40],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(40);
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c', 'd'],
			estimates: [30, 40, 40, 40],
			anchor: { kind: 'item', key: 'b' },
		});

		expect(test.writes).toBe(0);
		expect(test.controller.snapshot.positions.itemAt(1)?.start).toBe(0);
		expect(test.controller.snapshot.sizerSize).toBe(120);
		expect(test.controller.viewportPosition?.leadingContentReachable).toBe(false);

		test.controller.setScrollActivity('idle');
		test.environment.flushFrames();
		expect(test.controller.snapshot.sizerSize).toBe(150);
		test.environment.flushMicrotasks();
		expect(test.writes).toBe(1);
		expect(test.viewport.scrollTop).toBe(70);
	});

	it('anchors a replaced presentation key against its old geometry', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update', keys: ['before', 'member', 'after', 'tail'], estimates: [40, 40, 40, 80],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(48);
		test.controller.apply({
			kind: 'update', keys: ['before', 'summary', 'after', 'tail'], estimates: [20, 56, 40, 80],
			anchor: { kind: 'item-remap', oldKey: 'member', newKey: 'summary' },
		});
		test.environment.flushMicrotasks();
		expect(test.controller.snapshot.positions.itemAt(1)?.key).toBe('summary');
		expect(test.viewport.scrollTop).toBe(20);
		expect(test.records.at(-1)).toMatchObject({
			source: 'items', anchorKind: 'item-remap', anchorIndex: 1,
			anchorPaintedStartBefore: 40, anchorPaintedStartAfter: 20,
		});
	});

	it('keeps a shorter replacement visible when the old row was deeply scrolled', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['before', 'member', 'after', 'tail'],
			estimates: [40, 400, 40, 80],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(340);
		test.controller.apply({
			kind: 'update',
			keys: ['before', 'summary', 'after', 'tail'],
			estimates: [40, 56, 40, 80],
			anchor: { kind: 'item-remap', oldKey: 'member', newKey: 'summary' },
		});
		test.environment.flushMicrotasks();

		expect(test.viewport.scrollTop).toBe(40);
		expect(test.controller.snapshot.positions.itemAt(1)?.key).toBe('summary');
	});

	it('uses a pending correction when replacing a row before the first scroll commits', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update', keys: ['before', 'member', 'tail'], estimates: [1000, 400, 2000],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(1020);
		test.controller.apply({
			kind: 'update', keys: ['before', 'member', 'tail'], estimates: [300, 400, 2000],
			anchor: { kind: 'item', key: 'member' },
		});
		test.controller.apply({
			kind: 'update', keys: ['before', 'summary', 'tail'], estimates: [300, 56, 2000],
			anchor: { kind: 'item-remap', oldKey: 'member', newKey: 'summary' },
		});
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(300);
	});

	it('retargets a pending measurement anchor when a zero-correction remap replaces its key', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update', keys: ['before', 'member', 'tail'], estimates: [1000, 400, 2000],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(1000);
		test.controller.apply({
			kind: 'update', keys: ['before', 'member', 'tail'], estimates: [300, 400, 2000],
			anchor: { kind: 'item', key: 'member' },
		});
		test.controller.apply({
			kind: 'update', keys: ['before', 'summary', 'tail'], estimates: [300, 56, 2000],
			anchor: { kind: 'item-remap', oldKey: 'member', newKey: 'summary' },
		});
		test.mountItem('before', 500);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(500);
	});

	it('retargets measurements through consecutive remaps before the pending scroll commits', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update', keys: ['before', 'member', 'tail'], estimates: [1000, 400, 2000],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(1020);
		test.controller.apply({
			kind: 'update', keys: ['before', 'summary', 'tail'], estimates: [300, 56, 2000],
			anchor: { kind: 'item-remap', oldKey: 'member', newKey: 'summary' },
		});
		test.controller.apply({
			kind: 'update', keys: ['before', 'summary-2', 'tail'], estimates: [300, 56, 2000],
			anchor: { kind: 'item-remap', oldKey: 'summary', newKey: 'summary-2' },
		});
		test.mountItem('before', 500);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(500);
	});

	it('does not trust a replacement estimate taller than its measured height', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update', keys: ['before', 'member', 'tail'], estimates: [40, 400, 2000],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(100);
		test.controller.apply({
			kind: 'update', keys: ['before', 'summary', 'tail'], estimates: [40, 68, 2000],
			anchor: { kind: 'item-remap', oldKey: 'member', newKey: 'summary' },
		});
		test.environment.flushMicrotasks();
		test.mountItem('summary', 44);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(40);
	});

	it('defers a remapped-key correction while native scrolling is coasting', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update', keys: ['before', 'member', 'after', 'tail'], estimates: [40, 40, 40, 80],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(48);
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update', keys: ['before', 'summary', 'after', 'tail'], estimates: [20, 56, 40, 80],
			anchor: { kind: 'item-remap', oldKey: 'member', newKey: 'summary' },
		});
		expect(test.writes).toBe(0);
		expect(test.records.at(-1)).toMatchObject({
			source: 'items', anchorKind: 'item-remap', scrollWrites: 0,
		});
		test.controller.setScrollActivity('idle');
		test.environment.flushFrames();
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(20);
		expect(test.writes).toBe(1);
	});

	it('defers a deep replacement clamp until coasting ends', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update', keys: ['before', 'member', 'after', 'tail'], estimates: [40, 400, 40, 80],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(340);
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update', keys: ['before', 'summary', 'after', 'tail'], estimates: [40, 56, 40, 80],
			anchor: { kind: 'item-remap', oldKey: 'member', newKey: 'summary' },
		});
		expect(test.writes).toBe(0);
		test.controller.setScrollActivity('idle');
		test.environment.flushFrames();
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(40);
	});

	it('retries idle deviation when a scroll returns to physical bounds', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['b', 'c'],
			estimates: [80, 80],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(-10);
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [20, 80, 80],
			anchor: { kind: 'item', key: 'b' },
		});

		expect(test.writes).toBe(0);
		expect(test.controller.snapshot.sizerSize).toBe(160);
		test.setPhysicalScrollTop(0);
		test.environment.flushMicrotasks();

		expect(test.writes).toBe(1);
		expect(test.viewport.scrollTop).toBe(20);
		expect(test.controller.snapshot.sizerSize).toBe(180);
	});

	it('retries stale idle deviation when bounds recover without a scroll event', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['b', 'c'],
			estimates: [80, 80],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(-10);
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [20, 80, 80],
			anchor: { kind: 'item', key: 'b' },
		});

		test.setPhysicalScrollTopSilently(0);
		test.environment.advanceTime(1_000);
		test.environment.flushMicrotasks();

		expect(test.writes).toBe(1);
		expect(test.viewport.scrollTop).toBe(20);
	});

	it('solves a bounds clamp when scroll dispatch precedes viewport resize', () => {
		const test = harness({ viewportSize: 60 });
		test.controller.apply({
			kind: 'update',
			keys: ['b', 'c'],
			estimates: [50, 50],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(40);
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [30, 50, 50],
			anchor: { kind: 'item', key: 'b' },
		});

		test.setViewportSizeSilently(120);
		test.setPhysicalScrollTop(0);
		test.emitViewportResize();

		expect(test.controller.snapshot.sizerSize).toBe(120);
		expect(test.controller.viewportPosition?.logicalOffset).toBe(10);
		expect(test.records).toContainEqual(
			expect.objectContaining({
				source: 'viewport',
				deviationAfter: 10,
				clampedRemainder: 60,
				scrollWrites: 0,
			}),
		);
	});

	it.each(['scroll', 'resize'])('keeps user movement during a resize when %s arrives first', first => {
		const test = harness({ viewportSize: 100 });
		const keys = ['a', 'b', 'c', 'd'];
		const estimates = [100, 100, 100, 100];
		test.controller.apply({ kind: 'update', keys, estimates, anchor: { kind: 'none' } });
		test.setPhysicalScrollTop(250);
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update', keys: ['prepended', ...keys], estimates: [30, ...estimates],
			anchor: { kind: 'item', key: 'c' },
		});

		// The old 250px is unreachable, but 110px is user movement, not the new 200px edge.
		test.setViewportSizeSilently(200);
		expect(test.viewport.scrollHeight - test.viewport.clientHeight).toBe(200);
		test.setPhysicalScrollTopSilently(110);
		if (first === 'resize') test.emitViewportResize();
		test.viewport.dispatchEvent(new Event('scroll'));
		if (first === 'scroll') test.emitViewportResize();
		test.environment.flushMicrotasks();
		test.environment.flushFrames();
		test.environment.flushMicrotasks();
		expect(test.controller.viewportPosition?.logicalOffset).toBe(140);
		expect(test.writes).toBe(0);

		test.controller.setScrollActivity('idle');
		test.environment.flushFrames();
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(140);
		expect(test.writes).toBe(1);
	});

	it('records settled deviation and painted anchor coordinates', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['b', 'c'],
			estimates: [40, 40],
			anchor: { kind: 'none' },
		});
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [20, 40, 40],
			anchor: { kind: 'item', key: 'b' },
		});
		test.controller.apply({
			kind: 'update',
			keys: ['b', 'c'],
			estimates: [40, 40],
			anchor: { kind: 'item', key: 'b' },
		});

		expect(test.records.at(-1)).toMatchObject({
			deviationBefore: 20,
			deviationAfter: 0,
			anchorPaintedStartBefore: 0,
			anchorPaintedStartAfter: 0,
			scrollWrites: 0,
		});
	});

	it('publishes no overscan row when every candidate paints above the sizer', () => {
		const test = harness({ viewportSize: 80, overscan: 0 });
		test.controller.apply({
			kind: 'update',
			keys: ['b'],
			estimates: [80],
			anchor: { kind: 'none' },
		});
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b'],
			estimates: [80, 80],
			anchor: { kind: 'item', key: 'b' },
		});
		test.setLeadingOffset(100);
		test.setPhysicalScrollTop(0);

		expect(test.controller.snapshot.visibleRange).toEqual({ startIndex: 0, endIndex: 0 });
		expect(test.controller.snapshot.overscanRange).toBeNull();
	});

	it('keeps the intended range while redeeming deferred correction at idle', () => {
		const test = harness({ viewportSize: 80, overscan: 0 });
		test.controller.apply({
			kind: 'update',
			keys: ['b', 'c', 'd'],
			estimates: [40, 40, 40],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(40);
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c', 'd'],
			estimates: [30, 40, 40, 40],
			anchor: { kind: 'item', key: 'b' },
		});
		const deferredRange = test.controller.snapshot.visibleRange;

		test.controller.setScrollActivity('idle');
		test.environment.flushFrames();

		expect(test.controller.snapshot.visibleRange).toEqual(deferredRange);
		expect(test.writes).toBe(0);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(70);
	});

	it('reports the intended painted offset through a leading-offset redemption barrier', () => {
		const test = harness({ viewportSize: 80, overscan: 0 });
		test.controller.apply({
			kind: 'update',
			keys: ['b', 'c', 'd'],
			estimates: [40, 40, 40],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(40);
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c', 'd'],
			estimates: [30, 40, 40, 40],
			anchor: { kind: 'item', key: 'b' },
		});

		test.controller.setScrollActivity('idle');
		test.environment.flushFrames();
		test.setLeadingOffset(30);

		expect(test.viewport.scrollTop).toBe(40);
		expect(test.controller.viewportPosition).toMatchObject({
			paintedOffset: 70,
			logicalOffset: 70,
		});
		expect(test.controller.snapshot.positions.itemAt(1)?.start).toBe(30);
	});

	it('reports the published end offset while physical bounds await repaint', () => {
		const test = harness({ viewportSize: 80, overscan: 0 });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [40, 40, 40],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollHeight(100);

		expect(test.controller.scrollToEnd()).toEqual({ kind: 'scheduled' });

		expect(test.controller.viewportPosition).toMatchObject({
			paintedOffset: 40,
			logicalOffset: 40,
		});
	});

	it('folds a settlement-gated prepend into negative deviation before redemption', () => {
		const test = harness({ viewportSize: 80, overscan: 0 });
		test.controller.apply({
			kind: 'update',
			keys: ['before', 'reading', 'tail'],
			estimates: [200, 40, 40],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(62);
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update',
			keys: ['before', 'reading', 'tail'],
			estimates: [0, 40, 40],
			anchor: { kind: 'item', key: 'reading' },
		});

		test.controller.setScrollActivity('idle');
		test.environment.flushMicrotasks();
		expect(test.writes).toBe(0);
		test.controller.apply({
			kind: 'update',
			keys: ['earlier', 'before', 'reading', 'tail'],
			estimates: [300, 0, 40, 40],
			anchor: { kind: 'item', key: 'reading' },
		});
		test.environment.flushMicrotasks();

		expect(test.writes).toBe(1);
		expect(test.viewport.scrollTop).toBe(162);
		expect(test.controller.snapshot.positions.itemAt(2)?.start).toBe(test.viewport.scrollTop + 138);
	});

	it('keeps measured content fixed when prepended estimates settle after redemption', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['spacer', 'reading', 'tail'],
			estimates: [64, 40, 40],
			anchor: { kind: 'none' },
		});
		test.mountItem('spacer', 64);
		test.mountItem('reading', 40);
		test.environment.flushMicrotasks();

		test.controller.apply({
			kind: 'update',
			keys: ['spacer', 'earlier-1', 'earlier-2', 'reading', 'tail'],
			estimates: [64, 100, 100, 40, 40],
			anchor: { kind: 'item', key: 'reading' },
		});
		test.environment.flushMicrotasks();
		const writesBeforeMeasurement = test.writes;
		test.mountItem('earlier-1', 20);
		test.mountItem('earlier-2', 20);
		test.environment.flushMicrotasks();

		expect(test.controller.snapshot.positions.itemAt(3)?.start).toBe(104);
		expect(104 - test.viewport.scrollTop).toBe(64);
		expect(test.writes - writesBeforeMeasurement).toBe(1);
		expect(test.records.at(-1)).toMatchObject({
			source: 'mount',
			anchorIndex: 3,
			correction: -160,
			scrollWrites: 1,
		});
	});

	it('keeps measured content fixed when prepended estimates settle during coasting', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['spacer', 'reading', 'tail'],
			estimates: [64, 40, 40],
			anchor: { kind: 'none' },
		});
		test.mountItem('spacer', 64);
		test.mountItem('reading', 40);
		test.environment.flushMicrotasks();
		test.controller.setScrollActivity('coasting');

		test.controller.apply({
			kind: 'update',
			keys: ['spacer', 'earlier-1', 'earlier-2', 'reading', 'tail'],
			estimates: [64, 100, 100, 40, 40],
			anchor: { kind: 'item', key: 'reading' },
		});
		test.mountItem('earlier-1', 20);
		test.mountItem('earlier-2', 20);
		test.environment.flushMicrotasks();

		expect(test.writes).toBe(0);
		expect(test.controller.snapshot.positions.itemAt(3)?.start).toBe(64);
		test.controller.setScrollActivity('idle');
		test.environment.flushFrames();
		test.environment.flushMicrotasks();
		expect(104 - test.viewport.scrollTop).toBe(64);
		expect(test.writes).toBe(1);
	});

	it('does not skip beyond the viewport when choosing a first-measurement anchor', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['before', 'visible', 'batch-1', 'batch-2', 'measured-tail'],
			estimates: [100, 20, 20, 60, 100],
			anchor: { kind: 'none' },
		});
		test.mountItem('measured-tail', 100);
		test.environment.flushMicrotasks();
		test.setPhysicalScrollTop(100);

		test.mountItem('visible', 10);
		test.mountItem('batch-1', 10);
		test.mountItem('batch-2', 10);
		test.environment.flushMicrotasks();

		expect(test.viewport.scrollTop).toBe(100);
		expect(test.records.at(-1)).toMatchObject({
			source: 'mount',
			anchorIndex: 1,
			correction: 0,
			scrollWrites: 0,
		});
	});

	it('skips unmeasured content to a measured anchor within the viewport', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['before', 'visible', 'unmeasured-gap', 'measured-inside', 'tail'],
			estimates: [100, 20, 20, 20, 100],
			anchor: { kind: 'none' },
		});
		test.mountItem('measured-inside', 20);
		test.environment.flushMicrotasks();
		test.setPhysicalScrollTop(100);

		test.mountItem('visible', 10);
		test.environment.flushMicrotasks();

		expect(test.controller.snapshot.positions.itemAt(3)?.start).toBe(130);
		expect(130 - test.viewport.scrollTop).toBe(40);
		expect(test.records.at(-1)).toMatchObject({
			source: 'mount',
			anchorIndex: 3,
			correction: -10,
			scrollWrites: 1,
		});
	});

	it('preserves measured content across interleaved first measurements', () => {
		const test = harness({ viewportSize: 100 });
		test.controller.apply({
			kind: 'update',
			keys: ['before', 'visible', 'measured-middle', 'batch-after', 'reading', 'tail'],
			estimates: [100, 20, 20, 20, 20, 100],
			anchor: { kind: 'none' },
		});
		test.mountItem('measured-middle', 20);
		test.mountItem('reading', 20);
		test.environment.flushMicrotasks();
		test.setPhysicalScrollTop(100);
		const readingStart = test.controller.snapshot.positions.itemAt(4)?.start;
		expect(readingStart).toBe(160);
		const readingOffset = (readingStart ?? Number.NaN) - test.viewport.scrollTop;

		test.mountItem('visible', 10);
		test.mountItem('batch-after', 10);
		test.environment.flushMicrotasks();

		expect(test.controller.snapshot.positions.itemAt(4)?.start).toBe(140);
		expect(140 - test.viewport.scrollTop).toBe(readingOffset);
		expect(test.records.at(-1)).toMatchObject({
			source: 'mount',
			anchorIndex: 4,
			correction: -20,
			scrollWrites: 1,
		});
	});

	it('defers mutation-driven end follow without writing during coasting', () => {
		const test = harness({ viewportSize: 80, measurementAnchor: 'end' });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b'],
			estimates: [40, 40],
			anchor: { kind: 'none' },
		});
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [40, 40, 20],
			anchor: { kind: 'end' },
		});

		expect(test.writes).toBe(0);
		expect(test.controller.snapshot.sizerSize).toBe(80);
		expect(test.controller.snapshot.positions.itemAt(2)?.end).toBe(80);
		expect(test.records.at(-1)).toMatchObject({ provenance: 'follow', scrollWrites: 0 });
	});

	it('preserves the first intersecting geometric anchor through an above-row resize', () => {
		const test = harness({ viewportSize: 60 });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [40, 40, 40],
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(45);
		const first = test.mountItem('a', 60);
		test.environment.flushMicrotasks();

		expect(test.controller.measuredSize('a')).toBe(60);
		expect(test.viewport.scrollTop).toBe(65);
		expect(test.records.at(-1)).toMatchObject({
			source: 'mount',
			anchorIndex: 1,
			correction: 20,
			scrollWrites: 1,
		});
		first.detach?.();
	});

	it('ignores a delayed observer entry from an element replaced for the same key', () => {
		const test = harness();
		test.controller.apply({
			kind: 'update',
			keys: ['a'],
			estimates: [20],
			anchor: { kind: 'none' },
		});
		const first = test.mountItem('a', 30);
		const second = test.mountItem('a', 40);
		test.environment.flushMicrotasks();
		expect(test.controller.measuredSize('a')).toBe(40);

		test.environment.observer.emit(first.element, 90);
		test.environment.observer.emit(second.element, -10);
		expect(test.controller.measuredSize('a')).toBe(40);
		test.environment.observer.emit(second.element, 44);
		expect(test.controller.measuredSize('a')).toBe(44);
		expect(test.records.at(-1)).toMatchObject({
			source: 'resize',
			ignoredEntries: 2,
			published: true,
		});
		second.detach?.();
	});

	it('publishes final geometry before one owned programmatic write', () => {
		const test = harness({ viewportSize: 50 });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [50, 50, 50],
			anchor: { kind: 'none' },
		});
		let ownedDuringEvent = false;
		test.viewport.addEventListener('scroll', () => {
			ownedDuringEvent = test.controller.ownsScrollPosition;
		});

		expect(test.controller.scrollToEnd()).toEqual({ kind: 'scheduled' });
		expect(test.writes).toBe(0);
		test.environment.flushMicrotasks();
		expect(test.writes).toBe(1);
		expect(test.viewport.scrollTop).toBe(100);
		expect(ownedDuringEvent).toBe(true);
		expect(test.controller.ownsScrollPosition).toBe(true);
		test.environment.flushFrames();
		expect(test.controller.ownsScrollPosition).toBe(false);
	});

	it('publishes the corrected anchor range before an immediate scroll write', () => {
		const test = harness({ viewportSize: 100, overscan: 0 });
		const keys = Array.from({ length: 100 }, (_, index) => `item-${index}`);
		test.controller.apply({
			kind: 'update',
			keys,
			estimates: keys.map(() => 10),
			anchor: { kind: 'none' },
		});
		test.setPhysicalScrollTop(500);

		test.controller.apply({
			kind: 'reset-measurements',
			keys,
			estimates: keys.map(() => 20),
			anchor: { kind: 'item', key: 'item-50' },
		});

		expect(test.controller.snapshot.visibleRange).toEqual({ startIndex: 50, endIndex: 54 });
		expect(test.writes).toBe(0);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(1_000);
	});

	it('preserves a pending anchor correction through a resize batch', () => {
		const test = harness({ viewportSize: 100, overscan: 0 });
		const keys = Array.from({ length: 100 }, (_, index) => `item-${index}`);
		test.controller.apply({
			kind: 'update',
			keys,
			estimates: keys.map(() => 10),
			anchor: { kind: 'none' },
		});
		const retained = test.mountItem('item-10', 10);
		test.environment.flushMicrotasks();
		test.setPhysicalScrollTop(500);

		test.controller.apply({
			kind: 'reset-measurements',
			keys,
			estimates: keys.map(() => 20),
			anchor: { kind: 'item', key: 'item-50' },
		});
		test.environment.observer.emit(retained.element, 15);

		expect(test.controller.snapshot.visibleRange).toEqual({ startIndex: 50, endIndex: 54 });
		expect(test.writes).toBe(0);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(995);
		retained.detach?.();
	});

	it('keeps a semantic prepend anchor authoritative through first measurements', () => {
		const test = harness({ viewportSize: 100, overscan: 0 });
		test.controller.apply({
			kind: 'update',
			keys: ['top', 'before-anchor', 'reading', 'after-anchor', 'stable-bottom', 'tail'],
			estimates: [20, 20, 20, 20, 20, 20],
			anchor: { kind: 'none' },
		});
		test.mountItem('reading', 20);
		test.mountItem('stable-bottom', 20);
		test.environment.flushMicrotasks();
		const initialReadingOffset = test.controller.snapshot.positions.itemAt(2)?.start;
		expect(initialReadingOffset).toBe(40);

		test.controller.apply({
			kind: 'update',
			keys: [
				'earlier-1',
				'earlier-2',
				'top',
				'before-anchor',
				'reading',
				'after-anchor',
				'stable-bottom',
				'tail',
			],
			estimates: [100, 100, 20, 20, 20, 20, 20, 20],
			anchor: { kind: 'item', key: 'reading' },
		});
		test.mountItem('top', 10);
		test.mountItem('before-anchor', 10);
		test.mountItem('after-anchor', 10);
		const mountMeasurement = test.environment.microtasks.pop();
		mountMeasurement?.();
		test.environment.flushMicrotasks();

		const readingStart = test.controller.snapshot.positions.itemAt(4)?.start;
		expect(readingStart).toBe(220);
		expect((readingStart ?? Number.NaN) - test.viewport.scrollTop).toBe(initialReadingOffset);
		expect(test.records.at(-1)).toMatchObject({
			source: 'mount',
			anchorKind: 'item',
			intendedScrollTop: 180,
			scrollWrites: 1,
		});
	});

	it('publishes a programmatic target range before its scroll write', () => {
		const test = harness({ viewportSize: 100, overscan: 0 });
		const keys = Array.from({ length: 100 }, (_, index) => `item-${index}`);
		test.controller.apply({
			kind: 'update',
			keys,
			estimates: keys.map(() => 20),
			anchor: { kind: 'none' },
		});

		expect(test.controller.scrollToIndex(50)).toEqual({ kind: 'scheduled' });
		expect(test.controller.snapshot.visibleRange).toEqual({ startIndex: 50, endIndex: 54 });
		expect(test.writes).toBe(0);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(1_000);
	});

	it('targets physical scroll before leading content', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [40, 40, 40],
			anchor: { kind: 'none' },
		});
		test.setLeadingOffset(32);
		test.setPhysicalScrollTop(20);

		expect(test.controller.scrollToAnchor('a', 32)).toEqual({ kind: 'scheduled' });
		test.environment.flushMicrotasks();

		expect(test.viewport.scrollTop).toBe(0);
	});

	it.each(['before', 'after'])('keeps the reader offset when its row first measures %s the seek commits', timing => {
		const test = readerHarness({ before: 1000, reader: 192, after: 300, tail: 2000 }, { viewportOffset: -300.25 });
		if (timing === 'before') test.mountItem('reader', 800);
		expect(test.controller.scrollToAnchor('reader', -300.25)).toEqual({ kind: 'scheduled' });
		test.environment.flushMicrotasks();
		if (timing === 'after') {
			test.mountItem('reader', 800);
			test.environment.flushMicrotasks();
		}
		expect(test.controller.measuredSize('reader')).toBe(800);
		expect(test.viewport.scrollTop).toBe(1300.25);
		expect(test.writes).toBe(1);
	});

	it('falls back to the visible row when a pending measurement anchor is removed', () => {
		const test = readerHarness(
			{ before: 100, visible: 100, reader: 100, tail: 500 }, { viewportOffset: 10, viewportSize: 100 },
		);
		const before = test.mountItem('before', 100);
		test.controller.scrollToAnchor('reader', 10);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(190);

		test.environment.observer.emit(before.element, 120);
		test.controller.apply({
			kind: 'update', keys: ['before', 'visible', 'tail'], estimates: [100, 100, 500],
			anchor: { kind: 'none' },
		});
		test.environment.observer.emit(before.element, 150);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(240);
	});

	it('uses the new reader rather than a pending projection anchor for subsequent measurements', () => {
		let policy: VirtualMeasurementAnchor = 'geometric';
		const test = harness({ viewportSize: 200, get measurementAnchor() { return policy; } });
		const keys = ['before', 'other', 'reader', 'tail'];
		const estimates = [50, 50, 100, 500];
		test.controller.apply({ kind: 'update', keys, estimates, anchor: { kind: 'none' } });
		const before = test.mountItem('before', 50);
		const other = test.mountItem('other', 50);
		test.environment.flushMicrotasks();
		test.controller.apply({
			kind: 'update', keys: ['prepended', ...keys], estimates: [20, ...estimates], anchor: { kind: 'item', key: 'other' },
		});
		policy = { kind: 'item', key: 'reader', viewportOffset: 200 };
		test.environment.observer.emit(before.element, 60);
		policy = 'geometric';
		test.environment.observer.emit(other.element, 50);
		expect(test.records.at(-1)).toMatchObject({ source: 'resize', anchorIndex: 3 });
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(0);
		expect(test.writes).toBe(0);
	});

	it.each([
		{ offset: 100, before: 90, tailEstimate: 500, tail: 500, first: 0, expected: 0 },
		{ offset: 100, before: 130, tailEstimate: 500, tail: 500, first: 0, expected: 30 },
		{ offset: 50, before: 90, tailEstimate: 500, tail: 500, first: 0, expected: 40 },
		{ offset: -50, before: 50, tailEstimate: 60, tail: 70, first: 10, expected: 20 },
		{ offset: -50, before: 50, tailEstimate: 20, tail: 30, first: 0, expected: 0 },
	])('preserves the attainable reader offset at a physical edge: %j', ({ offset, before, tailEstimate, tail, first, expected }) => {
		const test = readerHarness({ before: 50, reader: 100, tail: tailEstimate }, { viewportOffset: offset });
		test.controller.scrollToAnchor('reader', offset);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(first);
		test.mountItem('before', before);
		test.mountItem('tail', tail);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(expected);
		expect(test.writes).toBe(expected === first ? 1 : 2);
	});

	it('resolves a clipped reader against committed bounds, not overflow from a resizing wrapper', () => {
		const test = readerHarness(
			{ before: 50, reader: 100, growing: 60, tail: 16 }, { viewportOffset: -50, viewportSize: 216 },
		);
		const growing = test.mountItem('growing', 60);
		test.controller.scrollToAnchor('reader', -50);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(10);

		test.setPhysicalScrollHeight(280);
		test.environment.observer.emit(growing.element, 130);
		test.setPhysicalScrollHeight(null);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(80);
	});

	it.each([
		{
			offset: -60, estimates: { before: 400, reader: 40, tail: 40 }, growing: 'reader', size: 240,
			paintedStart: 400, sizer: 680, userScrollTop: 279, afterInput: 279,
		},
		{
			offset: 100, estimates: { before: 50, reader: 100, tail: 500 }, growing: 'before', size: 60,
			paintedStart: 50, sizer: 650, userScrollTop: 50, afterInput: 60,
		},
	] as const)('cancels the exact seek without turning it into visual deviation: %j', scenario => {
		const { offset, estimates, growing, size, paintedStart, sizer, userScrollTop, afterInput } = scenario;
		const test = readerHarness(estimates, { viewportOffset: offset });
		const mounted = test.mountItem(growing, estimates[growing]);
		test.controller.scrollToAnchor('reader', offset);
		test.environment.flushMicrotasks();
		test.environment.observer.emit(mounted.element, size);
		test.viewport.dispatchEvent(new WheelEvent('wheel'));
		test.environment.flushMicrotasks();
		expect(test.controller.snapshot.positions.itemAt(1)!.start).toBe(paintedStart);
		expect(test.controller.snapshot.sizerSize).toBe(sizer);
		expect(test.controller.snapshot.visibleRange?.startIndex).toBe(0);
		test.setPhysicalScrollTop(userScrollTop);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(afterInput);
	});

	it.each([200.8, 201.2])('resumes a bottom-clamped reader after the browser attains %f', attained => {
		const test = readerHarness(
			{ before: 360, reader: 100, tail: 100 }, { viewportOffset: -300, viewportSize: 359 },
		);
		test.controller.scrollToAnchor('reader', -300);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(201);
		test.setPhysicalScrollTop(attained);
		const before = test.mountItem('before', 360);
		const tail = test.mountItem('tail', 100);
		test.environment.flushMicrotasks();
		test.environment.observer.emit(before.element, 350);
		test.environment.observer.emit(tail.element, 110);
		test.environment.flushMicrotasks();
		expect(test.writes).toBe(1);
		expect(test.viewport.scrollTop).toBe(attained);
		test.mountItem('reader', 500);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(601);
	});

	it('does not resume a newly attainable reader seek during native momentum', () => {
		const test = readerHarness({ before: 400, reader: 40, tail: 40 }, { viewportOffset: -60 });
		const reader = test.mountItem('reader', 40);
		test.controller.scrollToAnchor('reader', -60);
		test.environment.flushMicrotasks();
		test.environment.flushFrames();
		expect(test.viewport.scrollTop).toBe(280);

		test.controller.setScrollActivity('coasting');
		test.environment.observer.emit(reader.element, 240);
		test.environment.flushMicrotasks();
		test.environment.flushFrames();
		test.environment.flushMicrotasks();
		expect(test.controller.measuredSize('reader')).toBe(240);
		expect(test.viewport.scrollTop).toBe(280);
		expect(test.writes).toBe(1);

		test.controller.setScrollActivity('idle');
		test.mountItem('tail', 60);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(460);
		expect(test.writes).toBe(2);
	});

	it.each(['row', 'viewport'])('commits the reader start and leading inset together after a %s resize', source => {
		const test = readerHarness({ a: 100, b: 100, reader: 100, tail: 600 }, { viewportOffset: -50 });
		const a = test.mountItem('a', 100);
		test.controller.scrollToAnchor('reader', -50);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(250);
		test.environment.observer.emit(a.element, 150);
		test.setLeadingOffset(10);
		if (source === 'row') test.environment.observer.emit(a.element, 180);
		else test.emitViewportResize();
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(source === 'row' ? 340 : 310);
		expect(test.writes).toBe(2);
	});

	it('preserves a pending navigation target through a resize batch', () => {
		const test = harness({ viewportSize: 100, overscan: 0 });
		const keys = Array.from({ length: 100 }, (_, index) => `item-${index}`);
		test.controller.apply({
			kind: 'update',
			keys,
			estimates: keys.map(() => 20),
			anchor: { kind: 'none' },
		});
		const retained = test.mountItem('item-10', 20);
		test.environment.flushMicrotasks();
		test.setPhysicalScrollTop(500);

		expect(test.controller.scrollToIndex(50)).toEqual({ kind: 'scheduled' });
		test.environment.observer.emit(retained.element, 15);

		expect(test.controller.snapshot.visibleRange).toEqual({ startIndex: 50, endIndex: 54 });
		expect(test.writes).toBe(0);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(995);
		retained.detach?.();
	});

	it('keeps the intended target range across a leading-offset commit barrier', () => {
		const test = harness({ viewportSize: 100, overscan: 0 });
		const keys = Array.from({ length: 100 }, (_, index) => `item-${index}`);
		test.controller.apply({
			kind: 'update',
			keys,
			estimates: keys.map(() => 20),
			anchor: { kind: 'none' },
		});

		expect(test.controller.scrollToIndex(50)).toEqual({ kind: 'scheduled' });
		test.setLeadingOffset(30);
		test.environment.microtasks.shift()?.();

		expect(test.controller.snapshot.visibleRange).toEqual({ startIndex: 50, endIndex: 54 });
		expect(test.writes).toBe(0);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(1_030);
	});

	it('abandons a pending target when its viewport detaches before commit', () => {
		const test = harness({ viewportSize: 80, overscan: 0 });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c', 'd'],
			estimates: [40, 40, 40, 40],
			anchor: { kind: 'none' },
		});
		test.mountItem('b', 40);
		test.environment.flushMicrotasks();
		test.setPhysicalScrollTop(40);
		expect(test.controller.scrollToIndex(3)).toEqual({ kind: 'scheduled' });

		test.detachViewport();
		test.environment.flushMicrotasks();
		test.attachViewport();
		test.environment.flushMicrotasks();
		test.controller.setScrollActivity('coasting');
		const writesBeforeMeasurement = test.writes;
		test.mountItem('a', 60);
		test.environment.flushMicrotasks();

		expect(test.writes).toBe(writesBeforeMeasurement);
		expect(test.records.at(-1)).toMatchObject({
			source: 'mount',
			provenance: 'measurement',
			scrollWrites: 0,
		});
	});

	it('yields after repeated leading-offset barriers and retries on the next frame', () => {
		const test = harness({ viewportSize: 100, overscan: 0 });
		const keys = Array.from({ length: 100 }, (_, index) => `item-${index}`);
		test.controller.apply({
			kind: 'update',
			keys,
			estimates: keys.map(() => 20),
			anchor: { kind: 'none' },
		});
		expect(test.controller.scrollToIndex(50)).toEqual({ kind: 'scheduled' });

		for (const leadingOffset of [10, 20, 30]) {
			test.setLeadingOffset(leadingOffset);
			test.environment.microtasks.shift()?.();
		}
		expect(test.writes).toBe(0);
		const yieldedRecord = test.records.at(-1);
		expect(yieldedRecord).toMatchObject({
			source: 'programmatic',
			published: true,
			scrollWrites: 0,
		});
		const recordCount = test.records.length;

		expect(test.environment.frames.size).toBe(1);
		test.environment.flushFrames();
		test.environment.flushMicrotasks();
		expect(test.writes).toBe(1);
		expect(test.viewport.scrollTop).toBe(1_030);
		expect(test.records).toHaveLength(recordCount + 1);
		const completedRecord = test.records.at(-1);
		expect(completedRecord).toMatchObject({
			source: 'programmatic',
			published: true,
			scrollWrites: 1,
		});
		expect(completedRecord).not.toBe(yieldedRecord);
		expect(completedRecord?.durationMs).toBeLessThan(20);
	});

	it('cancels a delayed write without discarding painted deviation', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['b'],
			estimates: [80],
			anchor: { kind: 'none' },
		});
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b'],
			estimates: [20, 80],
			anchor: { kind: 'item', key: 'b' },
		});
		test.controller.setScrollActivity('idle');
		test.controller.cancelOwnedScroll();
		test.environment.flushMicrotasks();

		expect(test.writes).toBe(0);
		expect(test.controller.snapshot.sizerSize).toBe(80);
	});

	it('publishes no new revision for a range-preserving scroll', () => {
		const test = harness({ viewportSize: 100 });
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [200, 200, 200],
			anchor: { kind: 'none' },
		});
		const revision = test.controller.snapshot.revision;
		test.setPhysicalScrollTop(1);
		expect(test.controller.snapshot.revision).toBe(revision);
	});

	it('records a first measurement matching the estimate without republishing geometry', () => {
		const test = harness();
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'hidden'],
			estimates: [40, 0],
			anchor: { kind: 'none' },
		});
		const snapshot = test.controller.snapshot;
		test.mountItem('a', 40);
		test.mountItem('hidden', 0);
		test.environment.flushMicrotasks();

		expect(test.controller.measuredSize('a')).toBe(40);
		expect(test.controller.measuredSize('hidden')).toBe(0);
		expect(test.records.at(-1)).toMatchObject({ source: 'mount', published: false });
		expect(test.controller.snapshot).toBe(snapshot);
	});

	it('uses observer sizes when delivered first and otherwise measures uncached mounts before paint', () => {
		const test = harness();
		test.controller.apply({
			kind: 'update',
			keys: ['observed', 'unobserved'],
			estimates: [32, 32],
			anchor: { kind: 'none' },
		});
		test.controller.setScrollActivity('dragging');
		const observedRead = vi.fn(() => 41);
		const fallbackRead = vi.fn(() => 53);
		const observed = test.mountItem('observed', observedRead);
		test.mountItem('unobserved', fallbackRead);
		test.environment.observer.emit(observed.element, 41);
		test.environment.flushMicrotasks();

		expect(observedRead).not.toHaveBeenCalled();
		expect(fallbackRead).toHaveBeenCalledTimes(1);
		expect(test.controller.measuredSize('observed')).toBe(41);
		expect(test.controller.measuredSize('unobserved')).toBe(53);
		expect(test.writes).toBe(0);
	});

	it('skips viewport reads and transactions for a settled observer echo of a mount', () => {
		const test = harness();
		test.controller.apply({
			kind: 'update',
			keys: ['a'],
			estimates: [40],
			anchor: { kind: 'none' },
		});
		const mounted = test.mountItem('a', 40);
		test.environment.flushMicrotasks();
		const snapshot = test.controller.snapshot;
		const readViewport = vi.spyOn(test.viewport, 'getBoundingClientRect');
		const recordCount = test.records.length;

		test.environment.observer.emit(mounted.element, 40);

		expect(test.controller.snapshot).toBe(snapshot);
		expect(readViewport).not.toHaveBeenCalled();
		expect(test.records).toHaveLength(recordCount);
		test.environment.observer.emit(mounted.element, 56);
		expect(test.controller.measuredSize('a')).toBe(56);
		expect(test.records.at(-1)).toMatchObject({ source: 'resize', published: true });
	});

	it('still reconciles an unchanged observer delivery when a prepend awaits settlement', () => {
		const test = harness({ viewportSize: 80 });
		test.controller.apply({
			kind: 'update',
			keys: ['b', 'c'],
			estimates: [80, 80],
			anchor: { kind: 'none' },
		});
		const mounted = test.mountItem('b', 80);
		test.environment.flushMicrotasks();
		test.setPhysicalScrollTop(40);
		test.controller.setScrollActivity('coasting');
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b', 'c'],
			estimates: [20, 80, 80],
			anchor: { kind: 'item', key: 'b' },
		});
		const readingOffset = () => test.controller.snapshot.positions.itemAt(1)!.start - test.viewport.scrollTop;
		const before = readingOffset();
		test.environment.observer.emit(mounted.element, 80);
		expect(test.writes).toBe(0);

		test.controller.setScrollActivity('idle');
		test.environment.observer.emit(mounted.element, 80);
		test.environment.flushMicrotasks();
		expect(test.writes).toBe(1);
		expect(test.records.at(-1)).toMatchObject({ source: 'resize', deviationAfter: 0 });
		expect(readingOffset()).toBe(before);
	});

	it('reports visible leading content as reachable when it cannot align to the viewport top', () => {
		const test = harness({ viewportSize: 100 });
		test.setLeadingOffset(30);
		test.controller.apply({
			kind: 'update',
			keys: ['a'],
			estimates: [80],
			anchor: { kind: 'none' },
		});

		expect(test.viewport.scrollHeight).toBe(110);
		expect(test.controller.viewportPosition).toMatchObject({
			distanceFromStart: 0,
			leadingContentReachable: true,
		});
	});

	it('clears old surface state and resumes with one explicit target', () => {
		const test = harness({ viewportSize: 50 });
		test.controller.apply({
			kind: 'update',
			keys: ['old'],
			estimates: [80],
			anchor: { kind: 'none' },
		});
		test.controller.apply({
			kind: 'replace-surface',
			keys: ['new-a', 'new-b'],
			estimates: [40, 40],
		});
		expect(test.controller.snapshot.visibleRange).toBeNull();
		expect(test.controller.viewportPosition).toBeNull();

		expect(test.controller.scrollToEnd()).toEqual({ kind: 'scheduled' });
		test.environment.flushMicrotasks();
		expect(test.controller.snapshot.positions.itemAt(0)?.key).toBe('new-a');
		expect(test.viewport.scrollTop).toBe(30);
	});

	it('keeps replacement measurements hidden until the first target', () => {
		const test = harness({ viewportSize: 50 });
		test.controller.apply({
			kind: 'replace-surface',
			keys: ['new-a', 'new-b'],
			estimates: [40, 40],
		});
		const replacementRevision = test.controller.snapshot.revision;
		test.mountItem('new-a', 60);
		test.environment.flushMicrotasks();

		expect(test.controller.measuredSize('new-a')).toBe(60);
		expect(test.controller.snapshot.revision).toBe(replacementRevision);
		expect(test.controller.snapshot.visibleRange).toBeNull();
		expect(test.controller.scrollToEnd()).toEqual({ kind: 'scheduled' });
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(50);
	});

	it('prunes cached attachments for removed unmounted keys', () => {
		const test = harness();
		test.controller.apply({
			kind: 'update',
			keys: ['a', 'b'],
			estimates: [40, 40],
			anchor: { kind: 'none' },
		});
		const removedAttachment = test.controller.item('b');
		expect(test.controller.item('b')).toBe(removedAttachment);

		test.controller.apply({
			kind: 'update',
			keys: ['a'],
			estimates: [40],
			anchor: { kind: 'none' },
		});

		expect(test.controller.item('b')).not.toBe(removedAttachment);
	});

	it('attributes the first resumed target to the resume transaction', () => {
		const test = harness({ viewportSize: 50 });
		test.controller.apply({
			kind: 'replace-surface',
			keys: ['new-a', 'new-b'],
			estimates: [40, 40],
		});

		test.mountItem('new-a', 60);
		expect(test.controller.resume({ kind: 'end' })).toEqual({ kind: 'scheduled' });
		test.environment.flushMicrotasks();
		expect(test.records.at(-1)).toMatchObject({
			source: 'resume',
			provenance: 'navigation',
			scrollWrites: 1,
		});
		expect(test.viewport.scrollTop).toBe(50);
	});

	it.each([
		{
			target: { kind: 'start' } as const,
			range: { startIndex: 0, endIndex: 0 },
			offset: 12,
		},
		{
			target: { kind: 'end' } as const,
			range: { startIndex: 3, endIndex: 3 },
			offset: 162,
		},
		{
			target: { kind: 'anchor', key: 'c', viewportOffset: -5 } as const,
			range: { startIndex: 2, endIndex: 3 },
			offset: 117,
		},
	])(
		'publishes only the intended $target.kind range on reveal, then rereads committed layout',
		({ target, range, offset }) => {
			const test = harness({ viewportSize: 50 });
			test.controller.apply({
				kind: 'update',
				keys: ['a', 'b'],
				estimates: [50, 50],
				anchor: { kind: 'none' },
			});
			test.controller.suspend();
			const revision = test.controller.snapshot.revision;
			test.controller.apply({
				kind: 'update',
				keys: ['a', 'b', 'c', 'd'],
				estimates: [50, 50, 50, 50],
				anchor: { kind: 'none' },
			});
			expect(test.controller.snapshot.revision).toBe(revision);
			const reads = vi.spyOn(test.sizer, 'getBoundingClientRect');
			const writes = test.writes;

			expect(test.controller.resume(target)).toEqual({ kind: 'scheduled' });
			expect(reads).toHaveBeenCalledTimes(1);
			expect(test.controller.snapshot.revision).toBe(revision + 1);
			expect(test.controller.snapshot.visibleRange).toEqual(range);
			expect(test.writes).toBe(writes);

			test.setLeadingOffset(12);
			test.environment.flushMicrotasks();
			expect(reads.mock.calls.length).toBeGreaterThan(1);
			expect(test.viewport.scrollTop).toBe(offset);
			expect(test.writes).toBe(writes + 1);
		},
	);

	it('publishes current hidden updates without moving when the resume key was removed', () => {
		const test = harness({ viewportSize: 50 });
		test.controller.apply({
			kind: 'update',
			keys: ['old'],
			estimates: [50],
			anchor: { kind: 'none' },
		});
		test.controller.suspend();
		test.controller.apply({
			kind: 'update',
			keys: ['new'],
			estimates: [75],
			anchor: { kind: 'none' },
		});
		const revision = test.controller.snapshot.revision;
		const writes = test.writes;

		expect(test.controller.resume({ kind: 'anchor', key: 'old', viewportOffset: -5 })).toEqual({
			kind: 'missing-key',
		});
		expect(test.controller.snapshot.revision).toBe(revision + 1);
		expect(test.controller.snapshot.positions.itemAt(0)?.key).toBe('new');
		test.environment.flushMicrotasks();
		expect(test.writes).toBe(writes);
	});

	it('does not commit a cancelled reveal or expose the stale view in its place', () => {
		const test = harness({ viewportSize: 50 });
		test.controller.apply({
			kind: 'update',
			keys: ['old'],
			estimates: [300],
			anchor: { kind: 'none' },
		});
		test.controller.suspend();
		const writes = test.writes;
		expect(test.controller.resume({ kind: 'end' })).toEqual({ kind: 'scheduled' });

		test.controller.apply({ kind: 'replace-surface', keys: [], estimates: [] });
		test.environment.flushMicrotasks();
		test.environment.flushFrames();
		expect(test.writes).toBe(writes);
		expect(test.controller.snapshot.visibleRange).toBeNull();
		expect(test.controller.snapshot.positions.count).toBe(0);
		expect(test.controller.resume({ kind: 'anchor', key: 'old', viewportOffset: 0 })).toEqual({
			kind: 'missing-key',
		});
		expect(test.controller.snapshot.positions.count).toBe(0);
		expect(test.writes).toBe(writes);
	});

	it('rejects malformed mutations without changing the current snapshot', () => {
		const test = harness();
		const revision = test.controller.snapshot.revision;
		expect(
			test.controller.apply({
				kind: 'update',
				keys: ['same', 'same'],
				estimates: [10, 10],
				anchor: { kind: 'none' },
			}),
		).toEqual({ kind: 'rejected', reason: 'duplicate-key' });
		expect(test.controller.snapshot.revision).toBe(revision);
		expect(test.records.at(-1)).toMatchObject({
			source: 'items',
			rejectionReason: 'duplicate-key',
			published: false,
		});
	});
});
