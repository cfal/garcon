export interface WindowTabLayoutInput {
	order: readonly string[];
	activeId: string | null;
	pinnedIds: readonly string[];
	availableWidth: number;
	widths: ReadonlyMap<string, number>;
	gap: number;
	minimumLabeledWidth?: number;
	iconWidth?: number;
}

export type WindowTabLabelMode = 'full' | 'truncated' | 'icon-only';

export interface WindowTabPresentation {
	visibleIds: readonly string[];
	labelMode: WindowTabLabelMode;
}

export const DEFAULT_WINDOW_TAB_MINIMUM_LABELED_WIDTH = 64;
export const DEFAULT_WINDOW_TAB_ICON_WIDTH = 28;

export interface WindowTabCapacityInput {
	containerWidth: number;
	actionsWidth: number;
	auxiliaryWidth: number;
	gap: number;
	railChromeWidth: number;
}

export interface WindowTabCapacity {
	railWidth: number;
	contentWidth: number;
}

export function resolveWindowTabCapacity({
	containerWidth,
	actionsWidth,
	auxiliaryWidth,
	gap,
	railChromeWidth,
}: WindowTabCapacityInput): WindowTabCapacity {
	const railWidth = Math.max(0, containerWidth - actionsWidth - auxiliaryWidth - gap);

	return {
		railWidth,
		contentWidth: Math.max(0, railWidth - railChromeWidth),
	};
}

export function resolveWindowTabPresentation(input: WindowTabLayoutInput): WindowTabPresentation {
	const {
		order,
		activeId,
		pinnedIds,
		availableWidth,
		widths,
		gap,
		minimumLabeledWidth = DEFAULT_WINDOW_TAB_MINIMUM_LABELED_WIDTH,
		iconWidth = DEFAULT_WINDOW_TAB_ICON_WIDTH,
	} = input;
	if (order.some((surfaceId) => !widths.has(surfaceId))) {
		return { visibleIds: order, labelMode: 'full' };
	}
	const total = order.reduce(
		(sum, surfaceId, index) => sum + (widths.get(surfaceId) ?? 0) + (index > 0 ? gap : 0),
		0,
	);
	if (total <= availableWidth) return { visibleIds: order, labelMode: 'full' };

	const totalGaps = Math.max(0, order.length - 1) * gap;
	if (order.length * minimumLabeledWidth + totalGaps <= availableWidth) {
		return { visibleIds: order, labelMode: 'truncated' };
	}
	if (order.length * iconWidth + totalGaps <= availableWidth) {
		return { visibleIds: order, labelMode: 'icon-only' };
	}
	if (availableWidth < iconWidth) return { visibleIds: [], labelMode: 'icon-only' };

	const capacity = Math.floor((availableWidth + gap) / (iconWidth + gap));

	const selected = new Set<string>();

	if (activeId && order.includes(activeId)) selected.add(activeId);

	for (const surfaceId of [...pinnedIds, ...order]) {
		if (selected.size >= capacity) break;
		if (selected.has(surfaceId)) continue;
		if (!order.includes(surfaceId)) continue;
		selected.add(surfaceId);
	}
	return {
		visibleIds: order.filter((surfaceId) => selected.has(surfaceId)),
		labelMode: 'icon-only',
	};
}
