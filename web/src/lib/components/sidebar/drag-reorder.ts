export interface SortableDragLike {
	id: unknown;
	index?: unknown;
	initialIndex?: unknown;
}

export interface DragEndLike {
	canceled?: boolean;
	operation?: {
		source?: SortableDragLike | null;
		target?: SortableDragLike | null;
	} | null;
}

/** Checks if a drag node has the shape needed for reorder resolution.
 *  Replaces dnd-kit's isSortable to avoid coupling to its internal types. */
export function hasSortableShape(node: SortableDragLike | null | undefined): node is SortableDragLike {
	return node != null && 'id' in node;
}

function asStringId(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function asInteger(value: unknown): number | null {
	return Number.isInteger(value) ? (value as number) : null;
}

/**
 * Resolves list reorder indices from a dnd-kit drag-end payload.
 * Mirrors dnd-kit sortable mutate semantics for array-backed lists.
 */
export function resolveReorderIndices(
	event: DragEndLike,
	currentIds: string[],
): { from: number; to: number } | null {
	if (event.canceled) return null;
	const source = event.operation?.source;
	const target = event.operation?.target;
	if (!source || !target) return null;

	const sourceId = asStringId(source.id);
	const targetId = asStringId(target.id);
	const sourceIndex = currentIds.indexOf(sourceId);
	const targetIndex = currentIds.indexOf(targetId);
	const projectedIndex = asInteger(source.index);
	const initialIndex = asInteger(source.initialIndex);

	// Fallback path: dnd-kit may provide sortable indices even when IDs
	// are temporarily unresolved against a just-refreshed list snapshot.
	if (sourceIndex === -1 || targetIndex === -1) {
		if (initialIndex === null || projectedIndex === null) return null;
		if (
			initialIndex < 0 ||
			initialIndex >= currentIds.length ||
			projectedIndex < 0 ||
			projectedIndex >= currentIds.length ||
			initialIndex === projectedIndex
		) {
			return null;
		}
		return { from: initialIndex, to: projectedIndex };
	}

	// Prefer the projected sortable index only when it differs from the
	// source's resolved index. This matches dnd-kit mutate behavior.
	if (
		projectedIndex !== null &&
		projectedIndex >= 0 &&
		projectedIndex < currentIds.length &&
		projectedIndex !== sourceIndex
	) {
		return { from: sourceIndex, to: projectedIndex };
	}

	if (sourceIndex === targetIndex) return null;
	return { from: sourceIndex, to: targetIndex };
}

export function reorderIds(ids: string[], from: number, to: number): string[] {
	if (from === to) return ids;
	const next = [...ids];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

export function previewReorder(event: DragEndLike, currentIds: string[]): string[] | null {
	const indices = resolveReorderIndices(event, currentIds);
	if (!indices) return null;
	return reorderIds(currentIds, indices.from, indices.to);
}

export function arraysEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

export function sameMembers(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const seen = new Set(left);
	if (seen.size !== left.length) return false;
	for (const id of right) {
		if (!seen.has(id)) return false;
	}
	return true;
}

export function movedId(before: string[], after: string[]): string | null {
	if (!sameMembers(before, after)) return null;
	for (let index = 0; index < before.length; index += 1) {
		if (before[index] !== after[index]) {
			const candidate = after[index];
			return before.includes(candidate) ? candidate : null;
		}
	}
	return null;
}

export type RelativeReorderTarget =
	| { chatIdAbove: string; chatIdBelow?: never }
	| { chatIdBelow: string; chatIdAbove?: never };

export function resolveFilteredRelativeMove(
	chatId: string,
	finalVisibleOrder: string[],
): RelativeReorderTarget | null {
	const index = finalVisibleOrder.indexOf(chatId);
	if (index < 0) return null;

	const chatIdAbove = finalVisibleOrder[index - 1];
	if (chatIdAbove) return { chatIdAbove };

	const chatIdBelow = finalVisibleOrder[index + 1];
	if (chatIdBelow) return { chatIdBelow };

	return null;
}
