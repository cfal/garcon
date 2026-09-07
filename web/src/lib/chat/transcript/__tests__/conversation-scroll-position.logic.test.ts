import { describe, expect, it } from 'vitest';
import {
	inferConversationScrollDirection,
	isConversationViewportAtStart,
	isNearConversationPageBoundary,
} from '../conversation-scroll-position';

const position = (logicalOffset: number, leadingContentReachable = true) => ({
	logicalOffset,
	distanceFromStart: Math.max(0, logicalOffset),
	leadingContentReachable,
});

describe('conversation scroll position', () => {
	it('infers direction only from logical movement', () => {
		expect(inferConversationScrollDirection(100, position(80))).toBe('earlier');
		expect(inferConversationScrollDirection(100, position(120))).toBe('later');
		expect(inferConversationScrollDirection(100, position(100))).toBeNull();
		expect(inferConversationScrollDirection(null, position(100))).toBeNull();
		expect(inferConversationScrollDirection(100, null)).toBeNull();
	});

	it('uses logical distance for start state', () => {
		expect(isConversationViewportAtStart(position(1), 1)).toBe(true);
		expect(isConversationViewportAtStart(position(2), 1)).toBe(false);
		expect(isConversationViewportAtStart(null, 1)).toBeNull();
	});

	it('suppresses earlier paging while leading content is unreachable', () => {
		const input = {
			direction: 'earlier' as const,
			viewportHeight: 400,
			minimumDistance: 100,
			earlierViewportCount: 2,
			isAtEnd: () => false,
		};
		expect(isNearConversationPageBoundary({ ...input, position: position(700) })).toBe(true);
		expect(isNearConversationPageBoundary({ ...input, position: position(0, false) })).toBe(false);
		expect(isNearConversationPageBoundary({ ...input, position: null })).toBe(false);
	});

	it('delegates the later boundary to the end policy', () => {
		expect(
			isNearConversationPageBoundary({
				direction: 'later',
				position: position(100),
				viewportHeight: 400,
				minimumDistance: 100,
				earlierViewportCount: 2,
				isAtEnd: (distance) => distance === 400,
			}),
		).toBe(true);
	});
});
