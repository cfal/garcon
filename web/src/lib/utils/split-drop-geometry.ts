import * as m from '$lib/paraglide/messages.js';

export type SplitDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface SplitDropZonePresentation {
	zone: SplitDropZone;
	// Faint target-map region, matching the pointer bands in resolveDropZone
	// so every zone shows exactly where its hit area is.
	hitInsetClass: string;
	// Strong outcome preview showing the half (or whole) the drop will fill.
	resultInsetClass: string;
	label: () => string;
}

export const SPLIT_DROP_ZONES: SplitDropZonePresentation[] = [
	{
		zone: 'top',
		hitInsetClass: 'top-1.5 inset-x-1.5 bottom-[75%]',
		resultInsetClass: 'top-1.5 inset-x-1.5 bottom-[50%]',
		label: m.workspace_drop_zone_top,
	},
	{
		zone: 'bottom',
		hitInsetClass: 'bottom-1.5 inset-x-1.5 top-[75%]',
		resultInsetClass: 'bottom-1.5 inset-x-1.5 top-[50%]',
		label: m.workspace_drop_zone_bottom,
	},
	{
		zone: 'left',
		hitInsetClass: 'left-1.5 top-[25%] bottom-[25%] right-[75%]',
		resultInsetClass: 'left-1.5 inset-y-1.5 right-[50%]',
		label: m.workspace_drop_zone_left,
	},
	{
		zone: 'right',
		hitInsetClass: 'right-1.5 top-[25%] bottom-[25%] left-[75%]',
		resultInsetClass: 'right-1.5 inset-y-1.5 left-[50%]',
		label: m.workspace_drop_zone_right,
	},
	{
		zone: 'center',
		hitInsetClass: 'inset-[25%]',
		resultInsetClass: 'inset-1.5',
		label: m.workspace_drop_zone_replace,
	},
];

export function resolveDropZone(
	rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
	clientX: number,
	clientY: number,
): SplitDropZone {
	const x = clientX - rect.left;
	const y = clientY - rect.top;
	const edgeX = rect.width * 0.25;
	const edgeY = rect.height * 0.25;

	if (y < edgeY) return 'top';
	if (y > rect.height - edgeY) return 'bottom';
	if (x < edgeX) return 'left';
	if (x > rect.width - edgeX) return 'right';
	return 'center';
}

export function isSplitEdgeZone(zone: SplitDropZone): boolean {
	return zone !== 'center';
}

// True when a dragleave event actually exits the container instead of
// moving between its children -- child transitions fire dragleave too
// and clearing state on them makes drop overlays flicker.
export function dragLeftContainer(event: DragEvent): boolean {
	const related = event.relatedTarget as HTMLElement | null;
	return !related || !(event.currentTarget as HTMLElement).contains(related);
}
