import { describe, expect, it } from 'vitest';
import {
	resolveReorderIndices,
	hasSortableShape,
	previewReorder,
	resolveFilteredRelativeMove,
	movedId,
	type DragEndLike,
} from '../drag-reorder';

function buildEvent(partial: Partial<DragEndLike>): DragEndLike {
	return {
		canceled: false,
		operation: {
			source: { id: 'a', index: 0, initialIndex: 0 },
			target: { id: 'b', index: 1 },
		},
		...partial,
	};
}

describe('hasSortableShape', () => {
	it('returns true for an object with id', () => {
		expect(hasSortableShape({ id: 'a' })).toBe(true);
	});

	it('returns true for numeric id', () => {
		expect(hasSortableShape({ id: 42 })).toBe(true);
	});

	it('returns false for null', () => {
		expect(hasSortableShape(null)).toBe(false);
	});

	it('returns false for undefined', () => {
		expect(hasSortableShape(undefined)).toBe(false);
	});
});

describe('resolveReorderIndices', () => {
	it('returns null when drag is canceled', () => {
		const event = buildEvent({ canceled: true });
		expect(resolveReorderIndices(event, ['a', 'b'])).toBeNull();
	});

	it('uses projected source index when it differs from resolved source index', () => {
		const event = buildEvent({
			operation: {
				source: { id: 'a', index: 2, initialIndex: 0 },
				target: { id: 'b', index: 1 },
			},
		});
		expect(resolveReorderIndices(event, ['a', 'b', 'c'])).toEqual({ from: 0, to: 2 });
	});

	it('uses resolved target index when projected source index is unchanged', () => {
		const event = buildEvent({
			operation: {
				source: { id: 'a', index: 0, initialIndex: 0 },
				target: { id: 'c', index: 2 },
			},
		});
		expect(resolveReorderIndices(event, ['a', 'b', 'c'])).toEqual({ from: 0, to: 2 });
	});

	it('falls back to sortable indices when IDs cannot be resolved', () => {
		const event = buildEvent({
			operation: {
				source: { id: 'missing', index: 1, initialIndex: 0 },
				target: { id: 'also-missing', index: 1 },
			},
		});
		expect(resolveReorderIndices(event, ['a', 'b', 'c'])).toEqual({ from: 0, to: 1 });
	});

	it('returns null when both projected and target imply no move', () => {
		const event = buildEvent({
			operation: {
				source: { id: 'a', index: 0, initialIndex: 0 },
				target: { id: 'a', index: 0 },
			},
		});
		expect(resolveReorderIndices(event, ['a', 'b', 'c'])).toBeNull();
	});
});

describe('previewReorder', () => {
	it('returns a reordered array from drag indices', () => {
		const event = buildEvent({
			operation: {
				source: { id: 'a', index: 0, initialIndex: 0 },
				target: { id: 'c', index: 2 },
			},
		});

		expect(previewReorder(event, ['a', 'b', 'c'])).toEqual(['b', 'c', 'a']);
	});

	it('returns null when the event does not move an item', () => {
		const event = buildEvent({
			operation: {
				source: { id: 'a', index: 0, initialIndex: 0 },
				target: { id: 'a', index: 0 },
			},
		});

		expect(previewReorder(event, ['a', 'b', 'c'])).toBeNull();
	});
});

describe('movedId', () => {
	it('returns the item that moved into the first differing slot', () => {
		expect(movedId(['a', 'b', 'c'], ['a', 'c', 'b'])).toBe('c');
	});

	it('returns null when orders have different members', () => {
		expect(movedId(['a', 'b'], ['a', 'c'])).toBeNull();
	});
});

describe('resolveFilteredRelativeMove', () => {
	it('uses the visible predecessor when one exists', () => {
		expect(resolveFilteredRelativeMove('c', ['a', 'c', 'b'])).toEqual({
			chatIdAbove: 'a',
		});
	});

	it('uses the visible successor for a top drop', () => {
		expect(resolveFilteredRelativeMove('c', ['c', 'a', 'b'])).toEqual({
			chatIdBelow: 'a',
		});
	});

	it('returns null when no visible neighbor exists', () => {
		expect(resolveFilteredRelativeMove('c', ['c'])).toBeNull();
	});

	it('returns null when the moved chat is not visible', () => {
		expect(resolveFilteredRelativeMove('missing', ['a', 'b'])).toBeNull();
	});
});
