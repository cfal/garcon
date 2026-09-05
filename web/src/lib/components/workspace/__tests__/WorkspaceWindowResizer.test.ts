import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkspaceWindowResizer from '../WorkspaceWindowResizer.svelte';
import * as m from '$lib/paraglide/messages.js';

function renderResizer(direction: 'horizontal' | 'vertical' = 'horizontal') {
	const onPreview = vi.fn();
	const onCommit = vi.fn();
	const result = render(WorkspaceWindowResizer, {
		direction,
		ratio: 0.5,
		style: '',
		boundsFraction: 1,
		onPreview,
		onCommit,
		onReset: vi.fn(),
	});
	const separator = screen.getByRole('separator', { name: m.layout_resize_windows() });
	vi.spyOn(separator.parentElement!, 'getBoundingClientRect').mockReturnValue(
		new DOMRect(0, 0, 200, 100),
	);
	return { ...result, separator, onPreview, onCommit };
}

afterEach(() => {
	cleanup();
	document.body.style.userSelect = '';
	document.body.style.cursor = '';
});

describe('WorkspaceWindowResizer', () => {
	it('exposes the current clamped ratio to assistive technology', () => {
		const { separator } = renderResizer();

		expect(separator.getAttribute('aria-valuemin')).toBe('15');
		expect(separator.getAttribute('aria-valuemax')).toBe('85');
		expect(separator.getAttribute('aria-valuenow')).toBe('50');
	});

	it.each([
		['horizontal', 'w-px', 'inset-y-0', '40px', 'w-6'],
		['vertical', 'h-px', 'inset-x-0', '', 'h-6'],
	] as const)(
		'renders a one-pixel %s window separator',
		(direction, thickness, span, top, hitAreaSize) => {
			const { container } = renderResizer(direction);
			const line = container.querySelector('[data-workspace-window-separator-line]')!;
			const target = container.querySelector<HTMLElement>(
				'[data-workspace-window-resize-hit-area]',
			)!;

			expect(line.classList.contains('bg-border')).toBe(true);
			expect(line.classList.contains(thickness)).toBe(true);
			expect(line.classList.contains(span)).toBe(true);
			expect(target.classList.contains('pointer-events-auto')).toBe(true);
			expect(target.style.top).toBe(top);
			expect(target.classList.contains('bottom-0')).toBe(true);
			expect(target.classList.contains(hitAreaSize)).toBe(true);
		},
	);

	it('reverts a pointer preview on cancellation without committing it', async () => {
		const { separator, onPreview, onCommit } = renderResizer();

		await fireEvent.pointerDown(separator, {
			button: 0,
			isPrimary: true,
			pointerId: 1,
			clientX: 100,
		});
		await fireEvent.pointerMove(document, { pointerId: 1, clientX: 150 });
		await fireEvent.pointerCancel(document, { pointerId: 1 });

		expect(onPreview).toHaveBeenNthCalledWith(1, 0.75);
		expect(onPreview).toHaveBeenLastCalledWith(null);
		expect(onCommit).not.toHaveBeenCalled();
		expect(document.body.style.userSelect).toBe('');
		expect(document.body.style.cursor).toBe('');
	});

	it('commits one ratio on pointer release', async () => {
		const { separator, onCommit } = renderResizer();

		await fireEvent.pointerDown(separator, {
			button: 0,
			isPrimary: true,
			pointerId: 2,
			clientX: 100,
		});
		await fireEvent.pointerMove(document, { pointerId: 2, clientX: 150 });
		await fireEvent.pointerUp(document, { pointerId: 2, clientX: 150 });

		expect(onCommit).toHaveBeenCalledOnce();
		expect(onCommit).toHaveBeenCalledWith(0.75);
	});

	it('cleans up an active drag when unmounted', async () => {
		const { separator, onPreview, onCommit, unmount } = renderResizer();

		await fireEvent.pointerDown(separator, {
			button: 0,
			isPrimary: true,
			pointerId: 3,
			clientX: 100,
		});
		await fireEvent.pointerMove(document, { pointerId: 3, clientX: 140 });
		unmount();
		await fireEvent.pointerUp(document, { pointerId: 3, clientX: 160 });

		expect(onPreview).toHaveBeenLastCalledWith(null);
		expect(onCommit).not.toHaveBeenCalled();
		expect(document.body.style.userSelect).toBe('');
		expect(document.body.style.cursor).toBe('');
	});
});
