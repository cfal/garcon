import { describe, expect, it } from 'vitest';
import {
	ConversationTouchScrollGesture,
	conversationScrollbarScrollDirection,
	conversationScrollbarTrackDirection,
	conversationTouchScrollDirection,
	conversationWheelScrollDirection,
} from '../conversation-scroll-gesture.js';

describe('conversation scroll gesture direction', () => {
	it('maps finger movement to the inverse content direction', () => {
		expect(conversationTouchScrollDirection(100, 120)).toBe('earlier');
		expect(conversationTouchScrollDirection(100, 80)).toBe('later');
		expect(conversationTouchScrollDirection(100, 100)).toBeNull();
	});

	it('keeps the tracked finger stable when another touch starts or ends', () => {
		const gesture = new ConversationTouchScrollGesture();
		expect(gesture.begin([{ identifier: 1, clientY: 100 }])).toBe(true);
		expect(
			gesture.begin([
				{ identifier: 1, clientY: 100 },
				{ identifier: 2, clientY: 300 },
			]),
		).toBe(false);
		expect(
			gesture.move([
				{ identifier: 1, clientY: 120 },
				{ identifier: 2, clientY: 300 },
			]),
		).toBe('earlier');
		gesture.end([{ identifier: 2, clientY: 300 }]);
		expect(gesture.move([{ identifier: 2, clientY: 320 }])).toBe('earlier');
	});

	it('maps scrollbar-thumb movement to the matching content direction', () => {
		expect(conversationScrollbarScrollDirection(100, 80)).toBe('earlier');
		expect(conversationScrollbarScrollDirection(100, 120)).toBe('later');
		expect(conversationScrollbarScrollDirection(100, 100)).toBeNull();
	});

	it('maps a track press relative to the committed thumb', () => {
		expect(conversationScrollbarTrackDirection(40, 80, 120)).toBe('earlier');
		expect(conversationScrollbarTrackDirection(90, 80, 120)).toBe('earlier');
		expect(conversationScrollbarTrackDirection(110, 80, 120)).toBe('later');
		expect(conversationScrollbarTrackDirection(160, 80, 120)).toBe('later');
		expect(conversationScrollbarTrackDirection(100, 80, 120)).toBeNull();
	});

	it('maps wheel and trackpad deltas consistently', () => {
		expect(conversationWheelScrollDirection(-1)).toBe('earlier');
		expect(conversationWheelScrollDirection(1)).toBe('later');
		expect(conversationWheelScrollDirection(0)).toBeNull();
	});
});
