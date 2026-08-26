import type {
	LogicalVirtualItem,
	VirtualItem,
	VirtualPositionView,
	VirtualRange,
} from './virtual-list-types';

const INITIAL_CAPACITY = 16;

export interface VirtualGeometryOperationCounts {
	readonly mapWrites: number;
	readonly arrayGrowths: number;
	readonly prefixRebuilds: number;
	readonly rebuiltItems: number;
	readonly firstChangedIndex: number | null;
	readonly changedCount: number;
}

interface GeometryPositionGeneration {
	readonly count: number;
	readonly keys: readonly string[];
	readonly offsets: Float64Array;
}

function emptyOperationCounts(): VirtualGeometryOperationCounts {
	return {
		mapWrites: 0,
		arrayGrowths: 0,
		prefixRebuilds: 0,
		rebuiltItems: 0,
		firstChangedIndex: null,
		changedCount: 0,
	};
}

export class VirtualListGeometry {
	#keys: string[] = [];
	#indexByKey = new Map<string, number>();
	#measurements = new Map<string, number>();
	#estimates = new Float64Array(INITIAL_CAPACITY);
	#sizes = new Float64Array(INITIAL_CAPACITY);
	#offsets = new Float64Array(INITIAL_CAPACITY + 1);
	#count = 0;
	#dirtyFrom = 0;
	#revision = 0;
	#operations: VirtualGeometryOperationCounts = emptyOperationCounts();
	#positionGeneration: (GeometryPositionGeneration & { readonly revision: number }) | null = null;

	get count(): number {
		return this.#count;
	}

	get revision(): number {
		return this.#revision;
	}

	get operationCounts(): VirtualGeometryOperationCounts {
		this.#rebuild();
		return this.#operations;
	}

	setItems(keys: readonly string[], estimates: readonly number[]): void {
		if (keys.length !== estimates.length) throw new Error('Virtual keys and estimates differ');

		this.#operations = emptyOperationCounts();
		const oldCount = this.#count;
		const newCount = keys.length;
		let prefix = 0;
		while (prefix < oldCount && prefix < newCount && this.#keys[prefix] === keys[prefix]) {
			prefix += 1;
		}

		let suffix = 0;
		while (
			suffix < oldCount - prefix &&
			suffix < newCount - prefix &&
			this.#keys[oldCount - suffix - 1] === keys[newCount - suffix - 1]
		) {
			suffix += 1;
		}

		const sequenceChanged = prefix !== oldCount || prefix !== newCount;
		this.#ensureCapacity(newCount);

		if (sequenceChanged) {
			const removedEnd = oldCount - suffix;
			for (let index = prefix; index < removedEnd; index += 1) {
				const key = this.#keys[index];
				this.#indexByKey.delete(key);
			}

			const nextKeys = Array.from(keys);
			for (let index = prefix; index < newCount - suffix; index += 1) {
				this.#indexByKey.set(nextKeys[index], index);
				this.#incrementOperation('mapWrites');
			}

			for (let offset = 0; offset < suffix; offset += 1) {
				const oldIndex = oldCount - suffix + offset;
				const newIndex = newCount - suffix + offset;
				if (oldIndex === newIndex) continue;
				this.#indexByKey.set(nextKeys[newIndex], newIndex);
				this.#incrementOperation('mapWrites');
			}

			this.#keys = nextKeys;
			this.#count = newCount;
			for (let index = prefix; index < newCount; index += 1) {
				this.#estimates[index] = estimates[index];
			}
			this.#markDirty(prefix, Math.max(oldCount, newCount) - prefix);
		} else {
			for (let index = 0; index < newCount; index += 1) {
				if (this.#estimates[index] === estimates[index]) continue;
				this.#estimates[index] = estimates[index];
				this.#markDirty(index, 1);
			}
		}

		this.#pruneMeasurements();
	}

	replaceItems(keys: readonly string[], estimates: readonly number[]): void {
		this.#keys = [];
		this.#indexByKey.clear();
		this.#measurements.clear();
		this.#count = 0;
		this.#dirtyFrom = 0;
		this.#revision += 1;
		this.setItems(keys, estimates);
	}

	resetMeasurements(): void {
		if (this.#measurements.size === 0) return;
		let first = this.#count;
		for (const key of this.#measurements.keys()) {
			const index = this.#indexByKey.get(key);
			if (index !== undefined) first = Math.min(first, index);
		}
		this.#measurements.clear();
		if (first < this.#count) this.#markDirty(first, this.#count - first);
	}

	measure(key: string, size: number): number {
		return this.measureMany([{ key, size }]).delta;
	}

	measureMany(measurements: readonly { readonly key: string; readonly size: number }[]): {
		readonly delta: number;
		readonly changedCount: number;
		readonly firstChangedIndex: number | null;
	} {
		this.#operations = emptyOperationCounts();
		this.#rebuild();
		let delta = 0;
		let changedCount = 0;
		let firstChangedIndex: number | null = null;
		for (const measurement of measurements) {
			const { key, size } = measurement;
			const index = this.#indexByKey.get(key);
			if (index === undefined || this.#measurements.get(key) === size) continue;
			delta += size - this.#sizes[index];
			changedCount += 1;
			firstChangedIndex = firstChangedIndex === null ? index : Math.min(firstChangedIndex, index);
			this.#measurements.set(key, size);
			this.#markDirty(index, 1);
		}
		return { delta, changedCount, firstChangedIndex };
	}

	deleteMeasurement(key: string): void {
		if (!this.#measurements.delete(key)) return;
		const index = this.#indexByKey.get(key);
		if (index !== undefined) this.#markDirty(index, 1);
	}

	indexOf(key: string): number | undefined {
		return this.#indexByKey.get(key);
	}

	keyAt(index: number): string | undefined {
		return index >= 0 && index < this.#count ? this.#keys[index] : undefined;
	}

	item(index: number): LogicalVirtualItem | undefined {
		if (index < 0 || index >= this.#count) return undefined;
		this.#rebuild();
		return this.#logicalItem(index);
	}

	itemAtOffset(offset: number): LogicalVirtualItem | undefined {
		this.#rebuild();
		const index = this.#indexAtOffset(offset);
		return index === undefined ? undefined : this.#logicalItem(index);
	}

	range(offset: number, viewportSize: number): VirtualRange | null {
		this.#rebuild();
		if (this.#count === 0 || viewportSize <= 0) return null;

		const visibleStart = offset;
		const visibleEnd = offset + viewportSize;
		let index = this.#upperBoundOffset(visibleStart) - 1;
		index = Math.max(0, Math.min(index, this.#count - 1));
		while (index < this.#count && this.#offsets[index + 1] <= visibleStart) index += 1;
		while (index < this.#count && this.#sizes[index] === 0) index += 1;
		if (index >= this.#count || this.#offsets[index] >= visibleEnd) return null;

		const startIndex = index;
		let endIndex = index;
		for (; index < this.#count && this.#offsets[index] < visibleEnd; index += 1) {
			if (this.#offsets[index + 1] > visibleStart) endIndex = index;
		}
		return { startIndex, endIndex };
	}

	totalSize(): number {
		this.#rebuild();
		return this.#offsets[this.#count];
	}

	measuredSize(key: string): number | undefined {
		return this.#measurements.get(key);
	}

	positionView(deviation = 0): VirtualPositionView {
		this.#rebuild();
		if (this.#positionGeneration?.revision !== this.#revision) {
			this.#positionGeneration = {
				revision: this.#revision,
				count: this.#count,
				keys: this.#keys,
				offsets: this.#offsets.slice(0, this.#count + 1),
			};
		}
		return new GeometryPositionView(this.#positionGeneration, deviation);
	}

	#logicalItem(index: number): LogicalVirtualItem {
		const start = this.#offsets[index];
		const size = this.#sizes[index];
		return { key: this.#keys[index], index, start, size, end: start + size };
	}

	#indexAtOffset(offset: number): number | undefined {
		if (this.#count === 0) return undefined;
		const total = this.#offsets[this.#count];
		const target = Math.max(0, Math.min(offset, Math.max(0, total - Number.EPSILON)));
		let index = this.#upperBoundOffset(target) - 1;
		index = Math.max(0, Math.min(index, this.#count - 1));
		while (index < this.#count && this.#offsets[index + 1] <= target) index += 1;
		while (index < this.#count && this.#sizes[index] === 0) index += 1;
		if (index < this.#count) return index;
		for (index = this.#count - 1; index >= 0; index -= 1) {
			if (this.#sizes[index] > 0) return index;
		}
		return 0;
	}

	#upperBoundOffset(value: number): number {
		let low = 0;
		let high = this.#count + 1;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.#offsets[middle] <= value) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	#ensureCapacity(count: number): void {
		if (count <= this.#estimates.length) return;
		let capacity = this.#estimates.length;
		while (capacity < count) capacity *= 2;
		const estimates = new Float64Array(capacity);
		const sizes = new Float64Array(capacity);
		const offsets = new Float64Array(capacity + 1);
		estimates.set(this.#estimates.subarray(0, this.#count));
		sizes.set(this.#sizes.subarray(0, this.#count));
		offsets.set(this.#offsets.subarray(0, this.#count + 1));
		this.#estimates = estimates;
		this.#sizes = sizes;
		this.#offsets = offsets;
		this.#incrementOperation('arrayGrowths');
	}

	#markDirty(index: number, changedCount: number): void {
		this.#dirtyFrom = Math.min(this.#dirtyFrom, index);
		this.#revision += 1;
		const firstChangedIndex = this.#operations.firstChangedIndex;
		this.#operations = {
			...this.#operations,
			firstChangedIndex: firstChangedIndex === null ? index : Math.min(firstChangedIndex, index),
			changedCount: this.#operations.changedCount + changedCount,
		};
	}

	#rebuild(): void {
		if (this.#dirtyFrom >= this.#count) {
			this.#offsets[this.#count] = this.#count === 0 ? 0 : this.#offsets[this.#count];
			this.#dirtyFrom = this.#count;
			return;
		}

		const start = this.#dirtyFrom;
		if (start === 0) this.#offsets[0] = 0;
		for (let index = start; index < this.#count; index += 1) {
			const key = this.#keys[index];
			const size = this.#measurements.get(key) ?? this.#estimates[index];
			this.#sizes[index] = size;
			this.#offsets[index + 1] = this.#offsets[index] + size;
		}
		this.#dirtyFrom = this.#count;
		this.#operations = {
			...this.#operations,
			prefixRebuilds: this.#operations.prefixRebuilds + 1,
			rebuiltItems: this.#operations.rebuiltItems + this.#count - start,
		};
	}

	#pruneMeasurements(): void {
		for (const key of this.#measurements.keys()) {
			if (!this.#indexByKey.has(key)) this.#measurements.delete(key);
		}
	}

	#incrementOperation(key: 'mapWrites' | 'arrayGrowths'): void {
		this.#operations = { ...this.#operations, [key]: this.#operations[key] + 1 };
	}
}

class GeometryPositionView implements VirtualPositionView {
	constructor(
		private readonly generation: GeometryPositionGeneration,
		private readonly deviation: number,
	) {}

	get count(): number {
		return this.generation.count;
	}

	itemAt(index: number): VirtualItem | undefined {
		if (index < 0 || index >= this.generation.count) return undefined;
		const logicalStart = this.generation.offsets[index];
		const size = this.generation.offsets[index + 1] - logicalStart;
		const start = logicalStart - this.deviation;
		return {
			key: this.generation.keys[index],
			index,
			start,
			size,
			end: start + size,
		};
	}

	itemAtOffset(paintedOffset: number): VirtualItem | undefined {
		const index = this.#indexAtOffset(paintedOffset + this.deviation);
		return index === undefined ? undefined : this.itemAt(index);
	}

	#indexAtOffset(offset: number): number | undefined {
		if (this.generation.count === 0) return undefined;
		const total = this.generation.offsets[this.generation.count];
		const target = Math.max(0, Math.min(offset, Math.max(0, total - Number.EPSILON)));
		let index = this.#upperBoundOffset(target) - 1;
		index = Math.max(0, Math.min(index, this.generation.count - 1));
		while (index < this.generation.count && this.generation.offsets[index + 1] <= target) {
			index += 1;
		}
		while (
			index < this.generation.count &&
			this.generation.offsets[index + 1] === this.generation.offsets[index]
		) {
			index += 1;
		}
		if (index < this.generation.count) return index;
		for (index = this.generation.count - 1; index >= 0; index -= 1) {
			if (this.generation.offsets[index + 1] > this.generation.offsets[index]) return index;
		}
		return 0;
	}

	#upperBoundOffset(value: number): number {
		let low = 0;
		let high = this.generation.count + 1;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.generation.offsets[middle] <= value) low = middle + 1;
			else high = middle;
		}
		return low;
	}
}
