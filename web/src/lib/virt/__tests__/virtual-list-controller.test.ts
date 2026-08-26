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
		expect(test.controller.measuredSize('a')).toBe(40);
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
	});
});
