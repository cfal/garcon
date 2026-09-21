import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkspaceWindowResizer from '../WorkspaceWindowResizer.svelte';
import * as m from '$lib/paraglide/messages.js';

function renderResizer(
	direction: 'horizontal' | 'vertical' = 'horizontal',
	options: { minRatio?: number; maxRatio?: number; disabled?: boolean; ratio?: number } = {},
) {
	const onPreview = vi.fn();
	const onCommit = vi.fn();
	const result = render(WorkspaceWindowResizer, {
		direction,
		ratio: options.ratio ?? 0.5,
		style: '',
		boundsFraction: 1,
		minRatio: options.minRatio ?? 0.15,
		maxRatio: options.maxRatio ?? 0.85,
		disabled: options.disabled ?? false,
		onPreview,
		onCommit,
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
		const { separator } = renderResizer('horizontal', { minRatio: 0.3, maxRatio: 0.7 });

		expect(separator.getAttribute('aria-valuemin')).toBe('30');
		expect(separator.getAttribute('aria-valuemax')).toBe('70');
		expect(separator.getAttribute('aria-valuenow')).toBe('50');
		expect(separator.getAttribute('aria-disabled')).toBe('false');
	});

	it.each([
		{
			direction: 'horizontal',
			lineClasses: ['w-px', 'inset-y-0'],
			top: '40px',
			hitAreaClasses: [
				'w-6',
				'pointer-fine:inset-x-0',
				'pointer-fine:w-auto',
				'any-pointer-coarse:-left-2.5',
				'any-pointer-coarse:right-auto',
				'any-pointer-coarse:w-6',
			],
		},
		{
			direction: 'vertical',
			lineClasses: ['h-px', 'inset-x-0'],
			top: '',
			hitAreaClasses: [
				'h-6',
				'pointer-fine:inset-y-0',
				'pointer-fine:h-auto',
				'any-pointer-coarse:top-auto',
				'any-pointer-coarse:h-6',
			],
		},
	] as const)(
		'renders a one-pixel $direction separator with modality-aware hit targets',
		({ direction, lineClasses, top, hitAreaClasses }) => {
			const { container } = renderResizer(direction);
			const line = container.querySelector('[data-workspace-window-separator-line]')!;
			const target = container.querySelector<HTMLElement>(
				'[data-workspace-window-resize-hit-area]',
			)!;

			expect(line.classList.contains('bg-border')).toBe(true);
			for (const className of lineClasses) {
				expect(line.classList.contains(className)).toBe(true);
			}
			expect(target.classList.contains('pointer-events-auto')).toBe(true);
			expect(target.style.top).toBe(top);
			expect(target.classList.contains('bottom-0')).toBe(true);
			for (const className of hitAreaClasses) {
				expect(target.classList.contains(className)).toBe(true);
			}
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

	it.each([
		[20, 0.3],
		[180, 0.7],
	] as const)('clamps pointer movement at dynamic bounds', async (clientX, expected) => {
		const { separator, onPreview, onCommit } = renderResizer('horizontal', {
			minRatio: 0.3,
			maxRatio: 0.7,
		});

		await fireEvent.pointerDown(separator, {
			button: 0,
			isPrimary: true,
			pointerId: 4,
			clientX: 100,
		});
		await fireEvent.pointerMove(document, { pointerId: 4, clientX });
		await fireEvent.pointerUp(document, { pointerId: 4, clientX });

		expect(onPreview).toHaveBeenNthCalledWith(1, expected);
		expect(onCommit).toHaveBeenCalledWith(expected);
	});

	it('clamps keyboard resizing at dynamic bounds', async () => {
		const { separator, onCommit } = renderResizer('horizontal', {
			ratio: 0.3,
			minRatio: 0.3,
			maxRatio: 0.7,
		});

		await fireEvent.keyDown(separator, { key: 'ArrowLeft' });
		await fireEvent.keyDown(separator, { key: 'ArrowRight' });

		expect(onCommit).toHaveBeenNthCalledWith(1, 0.3);
		expect(onCommit).toHaveBeenNthCalledWith(2, 0.42);
	});

	it.each([
		[{ ratio: 0.6, minRatio: 0.3, maxRatio: 0.7 }, 0.5],
		[{ ratio: 0.7, minRatio: 0.6, maxRatio: 0.8 }, 0.6],
	] as const)('resets through the same dynamic clamp', async (options, expected) => {
		const { separator, onCommit } = renderResizer('horizontal', options);

		await fireEvent.dblClick(separator);

		expect(onCommit).toHaveBeenCalledOnce();
		expect(onCommit).toHaveBeenCalledWith(expected);
	});

	it('makes an infeasible separator unfocusable and inert', async () => {
		const { container, separator, onPreview, onCommit } = renderResizer('horizontal', {
			ratio: 0.6,
			minRatio: 0.6,
			maxRatio: 0.6,
			disabled: true,
		});
		const target = container.querySelector<HTMLElement>('[data-workspace-window-resize-hit-area]')!;

		expect(separator.getAttribute('aria-disabled')).toBe('true');
		expect(separator.getAttribute('tabindex')).toBe('-1');
		expect(target.classList.contains('pointer-events-none')).toBe(true);
		await fireEvent.pointerDown(separator, {
			button: 0,
			isPrimary: true,
			pointerId: 5,
			clientX: 100,
		});
		await fireEvent.pointerMove(document, { pointerId: 5, clientX: 150 });
		await fireEvent.pointerUp(document, { pointerId: 5, clientX: 150 });
		await fireEvent.keyDown(separator, { key: 'ArrowRight' });
		await fireEvent.dblClick(separator);

		expect(onPreview).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
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
