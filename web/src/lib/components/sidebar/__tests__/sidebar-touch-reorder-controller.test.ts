import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSidebarChatDragData } from '../sidebar-pragmatic-dnd';
import { SidebarTouchReorderController } from '../sidebar-touch-reorder-controller';

function touch(type: string, y: number, identifier = 1): TouchEvent {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const touches = [{ identifier, clientX: 0, clientY: y }];
	Object.defineProperties(event, {
		touches: { value: touches },
		changedTouches: { value: touches },
	});
	return event as TouchEvent;
}

describe('sidebar touch reorder', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('allows scrolling before long press, blocks it during drag and removes listeners on detach', () => {
		vi.useFakeTimers();
		const addListener = vi.spyOn(window, 'addEventListener');
		const onActivate = vi.fn();
		const onFinish = vi.fn();
		const onCancel = vi.fn();
		const source = getSidebarChatDragData({
			chatId: 'one',
			list: 'normal',
			index: 0,
			instanceId: Symbol(),
			reorderScopeKey: 'normal',
		});
		const row = document.createElement('div');
		document.body.append(row);
		const controller = new SidebarTouchReorderController({
			resolveSource: () => source,
			canActivate: () => true,
			viewport: () => null,
			scrollBy: vi.fn(),
			onActivate,
			onMove: vi.fn(),
			onFinish,
			onCancel,
		});
		const detach = controller.attach(row);
		try {
			row.dispatchEvent(touch('touchstart', 0));
			expect(
				addListener.mock.calls
					.filter(([type]) => type === 'touchmove')
					.map(([, , options]) => options),
			).toEqual([{ passive: true }]);
			expect(window.dispatchEvent(touch('touchmove', 20))).toBe(true);
			vi.advanceTimersByTime(360);
			expect(onActivate).not.toHaveBeenCalled();

			row.dispatchEvent(touch('touchstart', 0));
			vi.advanceTimersByTime(360);
			expect(onActivate).toHaveBeenCalledExactlyOnceWith(source);
			expect(addListener.mock.calls.filter(([type]) => type === 'touchmove').at(-1)?.[2]).toEqual({
				passive: false,
			});
			expect(window.dispatchEvent(touch('touchmove', 20, 2))).toBe(true);
			expect(window.dispatchEvent(touch('touchmove', 20))).toBe(false);
		} finally {
			detach();
			row.remove();
		}
		expect(onCancel).toHaveBeenCalledExactlyOnceWith(source);
		expect(window.dispatchEvent(touch('touchend', 20))).toBe(true);
		expect(onFinish).not.toHaveBeenCalled();
	});
});
