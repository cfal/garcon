import { describe, expect, it } from 'vitest';
import { VirtualListGeometry } from '../virtual-list-geometry';

interface ModelRow {
	key: string;
	estimate: number;
}

function random(seed: number): () => number {
	let value = seed >>> 0;
	return () => {
		value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
		return value / 0x1_0000_0000;
	};
}

function compareGeometry(
	geometry: VirtualListGeometry,
	rows: readonly ModelRow[],
	measurements: ReadonlyMap<string, number>,
): void {
	let offset = 0;
	for (const [index, row] of rows.entries()) {
		const size = measurements.get(row.key) ?? row.estimate;
		expect(geometry.item(index)).toEqual({
			key: row.key,
			index,
			start: offset,
			size,
			end: offset + size,
		});
		offset += size;
	}
	expect(geometry.totalSize()).toBeCloseTo(offset, 8);

	for (let sample = 0; sample <= 20; sample += 1) {
		const target = offset === 0 ? 0 : (offset * sample) / 20;
		const expected = rows.find((row) => {
			const index = rows.indexOf(row);
			const start = rows
				.slice(0, index)
				.reduce((sum, current) => sum + (measurements.get(current.key) ?? current.estimate), 0);
			return start + (measurements.get(row.key) ?? row.estimate) > target;
		});
		if (expected) expect(geometry.itemAtOffset(target)?.key).toBe(expected.key);
	}
}

describe('VirtualListGeometry properties', () => {
	it('matches a naive keyed model across deterministic mutation sequences', () => {
		for (let seed = 1; seed <= 25; seed += 1) {
			const next = random(seed);
			const geometry = new VirtualListGeometry();
			const rows: ModelRow[] = [];
			const measurements = new Map<string, number>();
			let nextKey = 0;

			for (let operation = 0; operation < 100; operation += 1) {
				const choice = Math.floor(next() * 6);
				if (choice === 0 || rows.length === 0) {
					rows.push({ key: `row-${nextKey++}`, estimate: Math.floor(next() * 80) / 2 });
				} else if (choice === 1) {
					rows.unshift({ key: `row-${nextKey++}`, estimate: Math.floor(next() * 80) / 2 });
				} else if (choice === 2) {
					const index = Math.floor(next() * rows.length);
					const [removed] = rows.splice(index, 1);
					measurements.delete(removed.key);
				} else if (choice === 3) {
					const row = rows[Math.floor(next() * rows.length)];
					row.estimate = Math.floor(next() * 100) / 4;
				} else if (choice === 4) {
					const row = rows[Math.floor(next() * rows.length)];
					const size = Math.floor(next() * 100) / 4;
					measurements.set(row.key, size);
					geometry.measure(row.key, size);
				} else {
					measurements.clear();
					geometry.resetMeasurements();
				}

				geometry.setItems(
					rows.map((row) => row.key),
					rows.map((row) => row.estimate),
				);
				compareGeometry(geometry, rows, measurements);
			}
		}
	});
});
