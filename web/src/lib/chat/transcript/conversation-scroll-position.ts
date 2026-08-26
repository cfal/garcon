import type { TranscriptPageDirection } from './transcript-page-progress';
import type { ConversationViewportPosition } from './conversation-viewport-port';

export function inferConversationScrollDirection(
	previousLogicalOffset: number | null,
	position: ConversationViewportPosition | null,
): TranscriptPageDirection | null {
	const current = position?.logicalOffset;
	if (previousLogicalOffset === null || current === undefined || previousLogicalOffset === current)
		return null;
	return current < previousLogicalOffset ? 'earlier' : 'later';
}

export function isConversationViewportAtStart(
	position: ConversationViewportPosition | null,
	threshold: number,
): boolean | null {
	return position ? position.distanceFromStart <= threshold : null;
}

export function isNearConversationPageBoundary(input: {
	readonly direction: TranscriptPageDirection;
	readonly position: ConversationViewportPosition | null;
	readonly viewportHeight: number;
	readonly minimumDistance: number;
	readonly earlierViewportCount: number;
	readonly isAtEnd: (distance: number) => boolean;
}): boolean {
	if (input.viewportHeight <= 0) return false;
	const viewportCount = input.direction === 'earlier' ? input.earlierViewportCount : 1;
	const distance = Math.max(input.minimumDistance, input.viewportHeight * viewportCount);
	if (input.direction === 'later') return input.isAtEnd(distance);
	const position = input.position;
	return Boolean(position?.leadingContentReachable && position.distanceFromStart <= distance);
}
