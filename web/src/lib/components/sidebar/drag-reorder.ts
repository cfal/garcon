import { reorder } from '@atlaskit/pragmatic-drag-and-drop/reorder';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { getReorderDestinationIndex } from '@atlaskit/pragmatic-drag-and-drop-hitbox/util/get-reorder-destination-index';

export type RelativeReorderTarget =
	| { chatIdAbove: string; chatIdBelow?: never }
	| { chatIdBelow: string; chatIdAbove?: never };

export type BoundaryMove = 'start' | 'end';

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

export function moveInOrder(input: {
	order: string[];
	sourceChatId: string;
	targetChatId: string;
	closestEdge: Edge | null;
}): string[] | null {
	const startIndex = input.order.indexOf(input.sourceChatId);
	const indexOfTarget = input.order.indexOf(input.targetChatId);
	if (startIndex < 0 || indexOfTarget < 0) return null;

	const finishIndex = getReorderDestinationIndex({
		startIndex,
		indexOfTarget,
		closestEdgeOfTarget: input.closestEdge,
		axis: 'vertical',
	});
	if (finishIndex === startIndex) return null;

	return reorder({
		list: input.order,
		startIndex,
		finishIndex,
	});
}

export function moveToBoundary(input: {
	order: string[];
	chatId: string;
	boundary: BoundaryMove;
}): string[] | null {
	const startIndex = input.order.indexOf(input.chatId);
	if (startIndex < 0) return null;
	const finishIndex = input.boundary === 'start' ? 0 : input.order.length - 1;
	if (finishIndex === startIndex) return null;

	return reorder({
		list: input.order,
		startIndex,
		finishIndex,
	});
}

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
