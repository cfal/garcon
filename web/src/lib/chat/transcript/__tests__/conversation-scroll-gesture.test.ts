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
	type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
	input: {
		pointerId: number;
		clientY: number;
		button?: number;
		buttons?: number;
		pointerType?: string;
	},
): void {
	const event = new Event(type, { bubbles: true });
	Object.defineProperties(event, {
		pointerId: { value: input.pointerId },
		clientY: { value: input.clientY },
		button: { value: input.button ?? 0 },
		buttons: { value: input.buttons ?? 0 },
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
			[{ direction: null, touch: 'start' }],
			[{ direction: 'earlier', touch: 'move' }],
			[{ direction: 'later', touch: 'move' }],
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
			[{ direction: null, touch: 'start' }],
			[{ direction: 'earlier', touch: 'move' }],
			[{ direction: null, touch: 'end' }],
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
			[{ direction: null, touch: 'start' }],
			[{ direction: 'earlier', touch: 'move' }],
			[{ direction: null, touch: 'end' }],
		]);
		cleanup();
	});

	it('does not classify an ordinary pointer click as scroll intent', () => {
		const node = document.createElement('div');
		const report = vi.fn();
		const cleanup = observeConversationViewportScrollGestures(node, report);

		dispatchPointer(node, 'pointerdown', { pointerId: 1, clientY: 120, buttons: 1 });
		dispatchPointer(node, 'pointermove', { pointerId: 1, clientY: 122, buttons: 1 });
		dispatchPointer(node, 'pointerup', { pointerId: 1, clientY: 120 });

		expect(report).not.toHaveBeenCalled();
		cleanup();
	});

	it('reports direction after a primary pointer drag begins', () => {
		const node = document.createElement('div');
		const report = vi.fn();
		const cleanup = observeConversationViewportScrollGestures(node, report);

		dispatchPointer(node, 'pointerdown', { pointerId: 1, clientY: 120, buttons: 1 });
		dispatchPointer(node, 'pointermove', { pointerId: 1, clientY: 100, buttons: 1 });
		dispatchPointer(node, 'pointermove', { pointerId: 1, clientY: 130, buttons: 1 });
		dispatchPointer(node, 'pointerup', { pointerId: 1, clientY: 130 });

		expect(report.mock.calls).toEqual([
			[{ direction: 'earlier', touch: null }],
			[{ direction: 'later', touch: null }],
		]);
		cleanup();
	});
});
