import { describe, expect, it } from 'vitest';
import {
	isQueuedInputDragData,
	placementFromEdge,
	queuedInputDragData,
} from '../queued-input-dnd.js';

describe('queued input drag data', () => {
	it('round-trips the stable queue entry identity', () => {
		const data = queuedInputDragData('entry-1');

		expect(data).toEqual({ type: 'queued-input', entryId: 'entry-1' });
		expect(isQueuedInputDragData(data)).toBe(true);
	});

	it('rejects unrelated and empty drag payloads', () => {
		expect(isQueuedInputDragData({ type: 'file', entryId: 'entry-1' })).toBe(false);
		expect(isQueuedInputDragData({ type: 'queued-input', entryId: '' })).toBe(false);
		expect(isQueuedInputDragData({ type: 'queued-input' })).toBe(false);
	});

	it('maps only vertical closest edges to queue placements', () => {
		expect(placementFromEdge('top')).toBe('before');
		expect(placementFromEdge('bottom')).toBe('after');
		expect(placementFromEdge('left')).toBeNull();
		expect(placementFromEdge(null)).toBeNull();
	});
});
