export interface WindowTabLayoutInput {
	order: readonly string[];
	activeId: string | null;
	activeTitleId?: string | null;
	availableWidth: number;
	widths: ReadonlyMap<string, number>;
	gap: number;
	minimumLabeledWidth?: number;
	iconWidth?: number;
	trailingReservedWidths?: ReadonlyMap<string, number>;
}

export type WindowTabLabelMode = 'full' | 'truncated' | 'icon-only';

export type WindowTabPresentation =
	| { visibleIds: readonly string[]; labelMode: WindowTabLabelMode }
	| { visibleIds: readonly string[]; labelMode: 'active-title'; activeTitleId: string };

export const DEFAULT_WINDOW_TAB_MINIMUM_LABELED_WIDTH = 64;
export const DEFAULT_WINDOW_TAB_ICON_WIDTH = 28;
export function sameVisibleTabs(left: readonly string[], right: readonly string[]): boolean {
	return (
		left === right ||
		(left.length === right.length && left.every((id, index) => id === right[index]))
	);
}

export function sameTabPresentation(
	left: WindowTabPresentation | null,
	right: WindowTabPresentation,
): boolean {
	return (
		left !== null &&
		left.labelMode === right.labelMode &&
		(left.labelMode !== 'active-title' ||
			(right.labelMode === 'active-title' && left.activeTitleId === right.activeTitleId)) &&
		sameVisibleTabs(left.visibleIds, right.visibleIds)
	);
}

export function resolveWindowTabPresentation(input: WindowTabLayoutInput): WindowTabPresentation {
	const {
		order,
		activeId,
		activeTitleId = null,
		availableWidth,
		widths,
		gap,
		minimumLabeledWidth = DEFAULT_WINDOW_TAB_MINIMUM_LABELED_WIDTH,
		iconWidth = DEFAULT_WINDOW_TAB_ICON_WIDTH,
		trailingReservedWidths,
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
	const minimumLabeledTotal = order.reduce(
		(sum, surfaceId) => sum + minimumLabeledWidth + (trailingReservedWidths?.get(surfaceId) ?? 0),
		totalGaps,
	);
	if (minimumLabeledTotal <= availableWidth) {
		return { visibleIds: order, labelMode: 'truncated' };
	}
	if (activeTitleId && activeTitleId === activeId && order.includes(activeTitleId)) {
		const activeTitleWidth =
			minimumLabeledWidth + (trailingReservedWidths?.get(activeTitleId) ?? 0);
		if (activeTitleWidth <= availableWidth) {
			const iconCapacity = Math.floor((availableWidth - activeTitleWidth) / (iconWidth + gap));
			const selected = new Set([
				activeTitleId,
				...order.filter((surfaceId) => surfaceId !== activeTitleId).slice(0, iconCapacity),
			]);
			return {
				visibleIds: order.filter((surfaceId) => selected.has(surfaceId)),
				labelMode: 'active-title',
				activeTitleId,
			};
		}
	}
	if (order.length * iconWidth + totalGaps <= availableWidth) {
		return { visibleIds: order, labelMode: 'icon-only' };
	}
	if (availableWidth < iconWidth) return { visibleIds: [], labelMode: 'icon-only' };

	const capacity = Math.floor((availableWidth + gap) / (iconWidth + gap));

	const selected = new Set<string>();

	if (activeId && order.includes(activeId)) selected.add(activeId);

	for (const surfaceId of order) {
		if (selected.size >= capacity) break;
		if (selected.has(surfaceId)) continue;
		selected.add(surfaceId);
	}
	return {
		visibleIds: order.filter((surfaceId) => selected.has(surfaceId)),
		labelMode: 'icon-only',
	};
}
