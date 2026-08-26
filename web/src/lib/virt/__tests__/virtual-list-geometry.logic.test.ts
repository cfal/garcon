import { describe, expect, it } from 'vitest';
import { VirtualListGeometry } from '../virtual-list-geometry';

describe('VirtualListGeometry', () => {
	it('builds exact prefix geometry and total size', () => {
		const geometry = new VirtualListGeometry();
		geometry.setItems(['a', 'b', 'c'], [20, 30.5, 0]);

		expect(geometry.item(0)).toEqual({ key: 'a', index: 0, start: 0, size: 20, end: 20 });
		expect(geometry.item(1)).toEqual({
			key: 'b',
			index: 1,
			start: 20,
			size: 30.5,
			end: 50.5,
		});
		expect(geometry.totalSize()).toBe(50.5);
	});

	it('retains keyed sizes through prepend', () => {
		const geometry = new VirtualListGeometry();
		geometry.setItems(['b', 'c'], [40, 40]);
		geometry.measure('b', 64);
		geometry.setItems(['a', 'b', 'c'], [32, 40, 40]);

		expect(geometry.item(1)).toMatchObject({ key: 'b', start: 32, size: 64 });
		expect(geometry.totalSize()).toBe(136);
	});

	it('prunes removed measurements and resets surviving measurements', () => {
		const geometry = new VirtualListGeometry();
		geometry.setItems(['a', 'b'], [20, 30]);
		geometry.measure('a', 40);
		geometry.measure('b', 50);
		geometry.setItems(['b'], [30]);

		expect(geometry.measuredSize('a')).toBeUndefined();
		expect(geometry.item(0)?.size).toBe(50);
		geometry.resetMeasurements();
		expect(geometry.item(0)?.size).toBe(30);
	});

	it('replaces the surface without carrying measurements', () => {
		const geometry = new VirtualListGeometry();
		geometry.setItems(['same'], [20]);
		geometry.measure('same', 80);
		geometry.replaceItems(['same'], [30]);

		expect(geometry.measuredSize('same')).toBeUndefined();
		expect(geometry.item(0)?.size).toBe(30);
	});

	it('looks up exact boundaries and skips repeated zero-height offsets', () => {
		const geometry = new VirtualListGeometry();
		geometry.setItems(['zero-a', 'a', 'zero-b', 'b'], [0, 10, 0, 20]);

		expect(geometry.itemAtOffset(0)?.key).toBe('a');
		expect(geometry.itemAtOffset(10)?.key).toBe('b');
		expect(geometry.itemAtOffset(100)?.key).toBe('b');
		expect(geometry.range(0, 10)).toEqual({ startIndex: 1, endIndex: 1 });
		expect(geometry.range(10, 20)).toEqual({ startIndex: 3, endIndex: 3 });
	});

	it('returns an empty range when only zero-height rows intersect', () => {
		const geometry = new VirtualListGeometry();
		geometry.setItems(['a', 'b'], [0, 0]);

		expect(geometry.range(0, 100)).toBeNull();
	});

	it('publishes painted coordinates without mutating logical geometry', () => {
		const geometry = new VirtualListGeometry();
		geometry.setItems(['a', 'b'], [20, 30]);
		const positive = geometry.positionView(12);
		const negative = geometry.positionView(-5);

		expect(positive.itemAt(1)).toEqual({
			key: 'b',
			index: 1,
			start: 8,
			size: 30,
			end: 38,
		});
		expect(positive.itemAtOffset(8)?.key).toBe('b');
		expect(negative.itemAt(0)?.start).toBe(5);
		expect(geometry.item(0)?.start).toBe(0);
	});

	it('keeps a published view immutable after geometry changes', () => {
		const geometry = new VirtualListGeometry();
		geometry.setItems(['a', 'b'], [20, 30]);
		const view = geometry.positionView();
		geometry.measure('a', 30);
		geometry.setItems(['before', 'a', 'b'], [10, 20, 30]);

		expect(view.count).toBe(2);
		expect(view.itemAt(0)).toEqual({ key: 'a', index: 0, start: 0, size: 20, end: 20 });
		expect(view.itemAt(1)).toEqual({ key: 'b', index: 1, start: 20, size: 30, end: 50 });
		expect(geometry.positionView().itemAt(1)).toEqual({
			key: 'a',
			index: 1,
			start: 10,
			size: 30,
			end: 40,
		});
	});

	it('updates a tail append incrementally with spare capacity', () => {
		const geometry = new VirtualListGeometry();
		const keys = Array.from({ length: 20_000 }, (_, index) => `row-${index}`);
		const estimates = keys.map(() => 32);
		geometry.setItems(keys, estimates);
		geometry.totalSize();

		geometry.setItems([...keys, 'row-20000'], [...estimates, 40]);
		expect(geometry.totalSize()).toBe(20_000 * 32 + 40);
		expect(geometry.operationCounts).toMatchObject({
			mapWrites: 1,
			arrayGrowths: 0,
			prefixRebuilds: 1,
			rebuiltItems: 1,
			firstChangedIndex: 20_000,
		});
	});
});
