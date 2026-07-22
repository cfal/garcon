import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { QueueEntryPlacement } from '$shared/chat-command-contracts';

export interface QueuedInputDragData extends Record<string | symbol, unknown> {
	type: 'queued-input';
	entryId: string;
}

export function queuedInputDragData(entryId: string): QueuedInputDragData {
	return { type: 'queued-input', entryId };
}

export function isQueuedInputDragData(
	value: Record<string | symbol, unknown>,
): value is Record<string | symbol, unknown> & QueuedInputDragData {
	return value.type === 'queued-input' && typeof value.entryId === 'string' && value.entryId.length > 0;
}

export function placementFromEdge(edge: Edge | null): QueueEntryPlacement | null {
	if (edge === 'top') return 'before';
	if (edge === 'bottom') return 'after';
	return null;
}
