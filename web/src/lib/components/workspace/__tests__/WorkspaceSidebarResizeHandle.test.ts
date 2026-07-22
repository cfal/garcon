import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import WorkspaceSidebarResizeHandle from '../WorkspaceSidebarResizeHandle.svelte';

function renderHandle(edge: 'start' | 'end' = 'start') {
	const onPreview = vi.fn();
	const onCommit = vi.fn();
	const onCancel = vi.fn();
	const onReset = vi.fn();
	const result = render(WorkspaceSidebarResizeHandle, {
		value: 480,
		edge,
		minimum: 360,
		maximum: 700,
		label: 'Resize sidebar',
		onPreview,
		onCommit,
		onCancel,
		onReset,
	});
	return { ...result, onPreview, onCommit, onCancel, onReset };
}

describe('WorkspaceSidebarResizeHandle', () => {
	it('previews pointer movement and commits only once on release', async () => {
		const { onPreview, onCommit } = renderHandle();
		const separator = screen.getByRole('slider') as HTMLElement;
		separator.setPointerCapture = vi.fn();
		separator.hasPointerCapture = vi.fn(() => true);
		separator.releasePointerCapture = vi.fn();

		await fireEvent.pointerDown(separator, {
			pointerId: 7,
			clientX: 500,
			button: 0,
			isPrimary: true,
		});
		await fireEvent.pointerMove(separator, { pointerId: 7, clientX: 450 });
		await fireEvent.pointerMove(separator, { pointerId: 7, clientX: 430 });

		expect(onPreview.mock.calls).toEqual([[530], [550]]);
		expect(onCommit).not.toHaveBeenCalled();

		await fireEvent.pointerUp(separator, { pointerId: 7, clientX: 430 });
		expect(onCommit).toHaveBeenCalledOnce();
		expect(onCommit).toHaveBeenCalledWith(550);
	});

	it('supports keyboard adjustment and reset without a drag', async () => {
		const { onCommit, onReset } = renderHandle();
		const separator = screen.getByRole('slider');

		await fireEvent.keyDown(separator, { key: 'ArrowLeft' });
		await fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true });
		await fireEvent.keyDown(separator, { key: 'End' });
		await fireEvent.keyDown(separator, { key: 'Home' });

		expect(onCommit.mock.calls).toEqual([[490], [520], [700]]);
		expect(onReset).toHaveBeenCalledOnce();
	});

	it('reverses pointer and keyboard direction on the end edge', async () => {
		const { onPreview, onCommit } = renderHandle('end');
		const separator = screen.getByRole('slider') as HTMLElement;
		separator.setPointerCapture = vi.fn();
		separator.hasPointerCapture = vi.fn(() => true);
		separator.releasePointerCapture = vi.fn();

		await fireEvent.pointerDown(separator, {
			pointerId: 8,
			clientX: 500,
			button: 0,
			isPrimary: true,
		});
		await fireEvent.pointerMove(separator, { pointerId: 8, clientX: 550 });
		await fireEvent.pointerUp(separator, { pointerId: 8, clientX: 550 });
		await fireEvent.keyDown(separator, { key: 'ArrowRight' });

		expect(onPreview).toHaveBeenCalledWith(530);
		expect(onCommit.mock.calls).toEqual([[530], [490]]);
	});
});
