import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AgentsSection from '../AgentsSection.svelte';
import * as providersApi from '$lib/api/providers.js';

vi.mock('$lib/api/providers.js', () => ({
	getAuthStatus: vi.fn()
}));

describe('AgentsSection', () => {
	it('shows CLI auth instructions instead of broken browser sign-in routes', async () => {
		vi.mocked(providersApi.getAuthStatus).mockResolvedValue({
			authenticated: false,
			canReauth: true,
			label: ''
		});

		const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

		render(AgentsSection);

		expect(await screen.findByText('claude login')).toBeTruthy();
		expect(screen.getByText('codex login')).toBeTruthy();
		expect(screen.getByText('opencode auth login')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: /Claude/i }));
		expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'More providers' }));
		expect(await screen.findByText('amp login')).toBeTruthy();
		expect(openSpy).not.toHaveBeenCalled();

		openSpy.mockRestore();
	});
});
