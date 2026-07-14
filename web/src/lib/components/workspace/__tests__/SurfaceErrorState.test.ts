import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import SurfaceErrorState from '../SurfaceErrorState.svelte';

describe('SurfaceErrorState', () => {
	it('renders retry and optional close actions', async () => {
		const onRetry = vi.fn();
		const onClose = vi.fn();
		render(SurfaceErrorState, {
			message: 'Renderer failed',
			onRetry,
			onClose,
		});

		expect(screen.getByText('Renderer failed')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: m.common_retry() }));
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_close_view() }));
		expect(onRetry).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('omits close when no close action is provided', () => {
		render(SurfaceErrorState, { message: 'Renderer failed', onRetry: vi.fn() });

		expect(screen.queryByRole('button', { name: m.workspace_close_view() })).toBeNull();
	});
});
