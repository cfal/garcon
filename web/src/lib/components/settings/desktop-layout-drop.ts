import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { getReorderDestinationIndex } from '@atlaskit/pragmatic-drag-and-drop-hitbox/util/get-reorder-destination-index';
import {
	moveDesktopLayoutPane,
	type DesktopLayoutOrder,
	type DesktopLayoutPane,
} from '$lib/layout/desktop-layout.js';

export function reorderDesktopLayoutPaneFromDrop(
	order: DesktopLayoutOrder,
	source: DesktopLayoutPane,
	target: DesktopLayoutPane,
	edge: Edge,
): DesktopLayoutOrder {
	const startIndex = order.indexOf(source);
	const indexOfTarget = order.indexOf(target);
	const destination = getReorderDestinationIndex({
		startIndex,
		indexOfTarget,
		closestEdgeOfTarget: edge,
		axis: 'vertical',
	});
	return moveDesktopLayoutPane(order, startIndex, destination);
}
