import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitFileTreeResizeHandle from '../GitFileTreeResizeHandle.svelte';

describe('GitFileTreeResizeHandle', () => {
	afterEach(cleanup);

	it('previews pointer movement and persists only when the drag ends', async () => {
		const onResize = vi.fn();
		const onResizeCommit = vi.fn();
		render(GitFileTreeResizeHandle, { width: 300, onResize, onResizeCommit });
		const slider = screen.getByRole('slider', { name: 'Resize file tree, 300 pixels' });
		slider.setPointerCapture = vi.fn();
		slider.hasPointerCapture = vi.fn(() => true);
		slider.releasePointerCapture = vi.fn();

		await fireEvent.pointerDown(slider, { button: 0, pointerId: 4, clientX: 300 });
		await fireEvent.pointerMove(slider, { pointerId: 4, clientX: 340 });

		expect(onResize).toHaveBeenLastCalledWith(340);
		expect(onResizeCommit).not.toHaveBeenCalled();

		await fireEvent.pointerUp(slider, { pointerId: 4, clientX: 340 });
		expect(onResizeCommit).toHaveBeenCalledTimes(1);
		expect(onResizeCommit).toHaveBeenLastCalledWith(340);
	});

	it('exposes resize values and commits keyboard resizing', async () => {
		const onResize = vi.fn();
		const onResizeCommit = vi.fn();
		render(GitFileTreeResizeHandle, { width: 300, onResize, onResizeCommit });
		const slider = screen.getByRole('slider', { name: 'Resize file tree, 300 pixels' });

		expect(slider.getAttribute('min')).toBe('220');
		expect(slider.getAttribute('max')).toBe('560');
		expect(slider.getAttribute('step')).toBe('1');
		expect((slider as HTMLInputElement).value).toBe('300');

		await fireEvent.keyDown(slider, { key: 'ArrowRight' });
		expect(onResize).toHaveBeenLastCalledWith(316);
		expect(onResizeCommit).toHaveBeenLastCalledWith(316);
	});
});
