import { describe, expect, it, vi } from 'vitest';
import { observeConversationViewportScrollGestures } from '../conversation-scroll-gesture.js';

function dispatchTouch(
	node: HTMLElement,
	type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
	touches: readonly { identifier: number; clientY: number }[],
	changedTouches: readonly { identifier: number; clientY: number }[] = touches,
): void {
	const event = new Event(type, { bubbles: true });
	Object.defineProperty(event, 'touches', { value: touches });
	Object.defineProperty(event, 'changedTouches', { value: changedTouches });
	node.dispatchEvent(event);
}

describe('conversation viewport scroll gestures', () => {
	function gestureHandlers() {
		return {
			onScrollIntent: vi.fn(),
			onContentTouchStart: vi.fn(),
			onContentTouchEnd: vi.fn(),
			onContentTouchReset: vi.fn(),
		};
	}

	it('keeps one active contact while continuing with the remaining finger', () => {
		const node = document.createElement('div');
		const handlers = gestureHandlers();
		const cleanup = observeConversationViewportScrollGestures(node, handlers);

		dispatchTouch(node, 'touchstart', [{ identifier: 1, clientY: 100 }]);
		dispatchTouch(node, 'touchstart', [
			{ identifier: 1, clientY: 100 },
			{ identifier: 2, clientY: 300 },
		], [{ identifier: 2, clientY: 300 }]);
		dispatchTouch(node, 'touchmove', [
			{ identifier: 1, clientY: 120 },
			{ identifier: 2, clientY: 300 },
		]);
		dispatchTouch(
			node,
			'touchend',
			[{ identifier: 2, clientY: 300 }],
			[{ identifier: 1, clientY: 120 }],
		);
		dispatchTouch(node, 'touchmove', [{ identifier: 2, clientY: 280 }]);
		dispatchTouch(node, 'touchend', [], [{ identifier: 2, clientY: 280 }]);

		expect(handlers.onScrollIntent.mock.calls).toEqual([[null], ['earlier'], ['later']]);
		expect(handlers.onContentTouchStart).toHaveBeenCalledOnce();
		expect(handlers.onContentTouchEnd).toHaveBeenCalledOnce();
		expect(handlers.onContentTouchReset).not.toHaveBeenCalled();
		cleanup();
		node.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
		expect(handlers.onScrollIntent).toHaveBeenCalledTimes(3);
	});

	it('ends active contact when the final touch is cancelled', () => {
		const node = document.createElement('div');
		const handlers = gestureHandlers();
		const cleanup = observeConversationViewportScrollGestures(node, handlers);

		dispatchTouch(node, 'touchstart', [{ identifier: 1, clientY: 100 }]);
		dispatchTouch(node, 'touchcancel', [], [{ identifier: 1, clientY: 100 }]);

		expect(handlers.onContentTouchStart).toHaveBeenCalledOnce();
		expect(handlers.onContentTouchEnd).toHaveBeenCalledOnce();
		expect(handlers.onContentTouchReset).not.toHaveBeenCalled();
		cleanup();
	});

	it('ends content ownership while an unrelated document touch remains', () => {
		const node = document.createElement('div');
		const handlers = gestureHandlers();
		const cleanup = observeConversationViewportScrollGestures(node, handlers);
		const outsideTouch = { identifier: 9, clientY: 400 };
		const contentTouch = { identifier: 1, clientY: 100 };

		dispatchTouch(node, 'touchstart', [outsideTouch, contentTouch], [contentTouch]);
		dispatchTouch(node, 'touchend', [outsideTouch], [contentTouch]);

		expect(handlers.onContentTouchStart).toHaveBeenCalledOnce();
		expect(handlers.onContentTouchEnd).toHaveBeenCalledOnce();
		cleanup();
	});

	it('resets active contact without ending it when observation cleans up', () => {
		const node = document.createElement('div');
		const handlers = gestureHandlers();
		const cleanup = observeConversationViewportScrollGestures(node, handlers);

		dispatchTouch(node, 'touchstart', [{ identifier: 1, clientY: 100 }]);
		cleanup();
		dispatchTouch(node, 'touchend', []);

		expect(handlers.onContentTouchStart).toHaveBeenCalledOnce();
		expect(handlers.onContentTouchEnd).not.toHaveBeenCalled();
		expect(handlers.onContentTouchReset).toHaveBeenCalledOnce();
	});
});
