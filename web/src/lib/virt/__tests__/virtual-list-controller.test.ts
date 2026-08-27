import { afterEach, describe, expect, it } from 'vitest';
import { createVirtualListHarness } from './virtual-list-test-harness';

const active: Array<ReturnType<typeof createVirtualListHarness>> = [];

function harness(options?: Parameters<typeof createVirtualListHarness>[0]) {
	const created = createVirtualListHarness(options);
	active.push(created);
	return created;
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
		expect(test.controller.snapshot.sizerSize).toBe(150);
		test.environment.flushMicrotasks();
		expect(test.writes).toBe(1);
		expect(test.viewport.scrollTop).toBe(70);
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

		expect(test.controller.snapshot.visibleRange).toEqual(deferredRange);
		expect(test.writes).toBe(0);
		test.environment.flushMicrotasks();
		expect(test.viewport.scrollTop).toBe(70);
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
		test.environment.observer.emit(second.element, 40);
		expect(test.controller.measuredSize('a')).toBe(40);
		expect(test.records.at(-1)).toMatchObject({
			source: 'resize',
			ignoredEntries: 2,
			published: false,
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

	it('publishes no new revision for an unchanged observer measurement', () => {
		const test = harness();
		test.controller.apply({
			kind: 'update',
			keys: ['a'],
			estimates: [40],
			anchor: { kind: 'none' },
		});
		const mounted = test.mountItem('a', 40);
		test.environment.flushMicrotasks();
		const revision = test.controller.snapshot.revision;

		test.environment.observer.emit(mounted.element, 40);

		expect(test.controller.snapshot.revision).toBe(revision);
		expect(test.records.at(-1)).toMatchObject({ source: 'resize', published: false });
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
