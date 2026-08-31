import { describe, expect, it, vi } from 'vitest';
import { observeConversationViewportScrollGestures } from '../conversation-scroll-gesture.js';

function dispatchTouch(
	node: HTMLElement,
	type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
	touches: readonly { identifier: number; clientY: number }[],
): void {
	const event = new Event(type, { bubbles: true });
	Object.defineProperty(event, 'touches', { value: touches });
	node.dispatchEvent(event);
}

function dispatchPointer(
	node: HTMLElement,
	type: 'pointerdown' | 'pointerup' | 'pointercancel',
	input: {
		pointerId: number;
		button?: number;
		pointerType?: string;
	},
): void {
	const event = new Event(type, { bubbles: true });
	Object.defineProperties(event, {
		pointerId: { value: input.pointerId },
		button: { value: input.button ?? 0 },
		pointerType: { value: input.pointerType ?? 'mouse' },
	});
	node.dispatchEvent(event);
}

describe('conversation viewport scroll gestures', () => {
	it('continues with the remaining finger after the tracked touch ends', () => {
		const node = document.createElement('div');
		const report = vi.fn();
		const cleanup = observeConversationViewportScrollGestures(node, report);

		dispatchTouch(node, 'touchstart', [{ identifier: 1, clientY: 100 }]);
		dispatchTouch(node, 'touchstart', [
			{ identifier: 1, clientY: 100 },
			{ identifier: 2, clientY: 300 },
		]);
		dispatchTouch(node, 'touchmove', [
			{ identifier: 1, clientY: 120 },
			{ identifier: 2, clientY: 300 },
		]);
		dispatchTouch(node, 'touchend', [{ identifier: 2, clientY: 300 }]);
		dispatchTouch(node, 'touchmove', [{ identifier: 2, clientY: 280 }]);

		expect(report.mock.calls).toEqual([
			[{ direction: null, touch: 'start', contact: 'start' }],
			[{ direction: 'earlier', touch: 'move', contact: null }],
			[{ direction: 'later', touch: 'move', contact: null }],
		]);
		cleanup();
		node.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
		expect(report).toHaveBeenCalledTimes(3);
	});

	it('delivers the terminal end signal when the last finger lifts', () => {
		const node = document.createElement('div');
		const report = vi.fn();
		const cleanup = observeConversationViewportScrollGestures(node, report);

		dispatchTouch(node, 'touchstart', [{ identifier: 1, clientY: 100 }]);
		dispatchTouch(node, 'touchmove', [{ identifier: 1, clientY: 120 }]);
		dispatchTouch(node, 'touchend', []);

		expect(report.mock.calls).toEqual([
			[{ direction: null, touch: 'start', contact: 'start' }],
			[{ direction: 'earlier', touch: 'move', contact: null }],
			[{ direction: null, touch: 'end', contact: 'end' }],
		]);
		cleanup();
	});

	it('delivers the terminal cancel signal as an end', () => {
		const node = document.createElement('div');
		const report = vi.fn();
		const cleanup = observeConversationViewportScrollGestures(node, report);

		dispatchTouch(node, 'touchstart', [{ identifier: 1, clientY: 100 }]);
		dispatchTouch(node, 'touchmove', [{ identifier: 1, clientY: 120 }]);
		dispatchTouch(node, 'touchcancel', []);

		expect(report.mock.calls).toEqual([
			[{ direction: null, touch: 'start', contact: 'start' }],
			[{ direction: 'earlier', touch: 'move', contact: null }],
			[{ direction: null, touch: 'end', contact: 'end' }],
		]);
		cleanup();
	});

	it('delimits an ordinary pointer press without assigning a direction', () => {
		const node = document.createElement('div');
		const report = vi.fn();
		const cleanup = observeConversationViewportScrollGestures(node, report);

		dispatchPointer(node, 'pointerdown', { pointerId: 1 });
		dispatchPointer(node, 'pointerup', { pointerId: 1 });

		expect(report.mock.calls).toEqual([
			[{ direction: null, touch: null, contact: 'start' }],
			[{ direction: null, touch: null, contact: 'end' }],
		]);
		cleanup();
	});

	it('delivers pointer cancellation as a terminal contact', () => {
		const node = document.createElement('div');
		const report = vi.fn();
		const cleanup = observeConversationViewportScrollGestures(node, report);

		dispatchPointer(node, 'pointerdown', { pointerId: 1 });
		dispatchPointer(node, 'pointercancel', { pointerId: 1 });

		expect(report.mock.calls).toEqual([
			[{ direction: null, touch: null, contact: 'start' }],
			[{ direction: null, touch: null, contact: 'end' }],
		]);
		cleanup();
	});
});
