import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposerResizeHandle from '../ComposerResizeHandle.svelte';

function renderHandle() {
	const onPreview = vi.fn();
	const onCommit = vi.fn();
	const onCancel = vi.fn();
	const onReset = vi.fn();
	const result = render(ComposerResizeHandle, {
		value: 140,
		minimum: 52,
		maximum: 500,
		label: 'Resize message composer',
		onPreview,
		onCommit,
		onCancel,
		onReset,
	});
	return { ...result, onPreview, onCommit, onCancel, onReset };
}

describe('ComposerResizeHandle', () => {
	afterEach(() => {
		cleanup();
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
	});

	it('previews captured pointer movement and commits once on release', async () => {
		const { onPreview, onCommit, onCancel } = renderHandle();
		const slider = screen.getByRole('slider', { name: 'Resize message composer' });
		slider.setPointerCapture = vi.fn();
		slider.hasPointerCapture = vi.fn(() => true);
		slider.releasePointerCapture = vi.fn();
		document.body.style.cursor = 'crosshair';
		document.body.style.userSelect = 'text';

		await fireEvent.pointerDown(slider, {
			pointerId: 7,
			clientY: 500,
			button: 0,
			isPrimary: true,
		});
		await fireEvent.pointerMove(slider, { pointerId: 7, clientY: 450 });
		await fireEvent.pointerMove(slider, { pointerId: 7, clientY: 420 });

		expect(onPreview.mock.calls).toEqual([[190], [220]]);
		expect(onCommit).not.toHaveBeenCalled();
		expect(document.body.style.cursor).toBe('row-resize');
		expect(document.body.style.userSelect).toBe('none');

		await fireEvent.pointerUp(slider, { pointerId: 7, clientY: 420 });

		expect(onCommit).toHaveBeenCalledOnce();
		expect(onCommit).toHaveBeenCalledWith(220);
		expect(onCancel).not.toHaveBeenCalled();
		expect(slider.releasePointerCapture).toHaveBeenCalledWith(7);
		expect(document.body.style.cursor).toBe('crosshair');
		expect(document.body.style.userSelect).toBe('text');
	});

	it('cancels its reactive preview when pointer capture is interrupted', async () => {
		const { onPreview, onCommit, onCancel } = renderHandle();
		const slider = screen.getByRole('slider', { name: 'Resize message composer' });
		slider.setPointerCapture = vi.fn();
		slider.hasPointerCapture = vi.fn(() => false);

		await fireEvent.pointerDown(slider, {
			pointerId: 8,
			clientY: 300,
			button: 0,
			isPrimary: true,
		});
		await fireEvent.pointerMove(slider, { pointerId: 8, clientY: 350 });
		await fireEvent.pointerCancel(slider, { pointerId: 8 });

		expect(onPreview).toHaveBeenCalledWith(90);
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onCommit).not.toHaveBeenCalled();
	});

	it('supports standard slider keys and double-click reset', async () => {
		const { onCommit, onReset } = renderHandle();
		const slider = screen.getByRole('slider', { name: 'Resize message composer' });

		expect(slider.getAttribute('min')).toBe('52');
		expect(slider.getAttribute('max')).toBe('500');
		expect(slider.getAttribute('step')).toBe('1');
		expect(slider.getAttribute('aria-orientation')).toBe('vertical');
		expect((slider as HTMLInputElement).value).toBe('140');

		await fireEvent.keyDown(slider, { key: 'ArrowUp' });
		await fireEvent.keyDown(slider, { key: 'ArrowDown', shiftKey: true });
		await fireEvent.keyDown(slider, { key: 'Home' });
		await fireEvent.keyDown(slider, { key: 'End' });
		await fireEvent.doubleClick(slider);

		expect(onCommit.mock.calls).toEqual([[150], [100], [52], [500]]);
		expect(onReset).toHaveBeenCalledOnce();
	});

	it('ignores non-primary and secondary pointers', async () => {
		const { onPreview, onCommit } = renderHandle();
		const slider = screen.getByRole('slider', { name: 'Resize message composer' });
		slider.setPointerCapture = vi.fn();

		await fireEvent.pointerDown(slider, {
			pointerId: 9,
			clientY: 300,
			button: 2,
			isPrimary: true,
		});
		await fireEvent.pointerDown(slider, {
			pointerId: 10,
			clientY: 300,
			button: 0,
			isPrimary: false,
		});
		await fireEvent.pointerMove(slider, { pointerId: 10, clientY: 200 });

		expect(slider.setPointerCapture).not.toHaveBeenCalled();
		expect(onPreview).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
	});
});
