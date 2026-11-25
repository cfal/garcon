import type { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
import type { VirtualMutationAnchor, VirtualRange } from '$lib/virt/virtual-list-types.js';

export function indexesInRange(range: VirtualRange | null): number[] {
	if (!range) return [];
	return Array.from(
		{ length: range.endIndex - range.startIndex + 1 },
		(_, offset) => range.startIndex + offset,
	);
}

export function currentAnchor(
	virtual: Pick<VirtualListController, 'viewportPosition' | 'snapshot'>,
): VirtualMutationAnchor {
	const position = virtual.viewportPosition;
	const item = position
		? virtual.snapshot.positions.itemAtOffset(position.paintedOffset)
		: undefined;
	return item ? { kind: 'item', key: item.key } : { kind: 'none' };
}
