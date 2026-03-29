import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AgentsSection from '../AgentsSection.svelte';
import * as providersApi from '$lib/api/providers.js';

vi.mock('$lib/api/providers.js', () => ({
	getAuthStatus: vi.fn(),
	launchAuthLogin: vi.fn()
}));

describe('AgentsSection', () => {
	it('launches provider login from the authenticated UI and keeps CLI-only providers as instructions', async () => {
		vi.mocked(providersApi.getAuthStatus).mockImplementation(async (provider) => {
			if (provider === 'opencode' || provider === 'amp') {
				return { authenticated: false, canReauth: false, label: '' };
			}
			return { authenticated: false, canReauth: true, label: '' };
		});
		vi.mocked(providersApi.launchAuthLogin).mockResolvedValue({
			launched: true,
			alreadyRunning: false,
		});

		const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

		render(AgentsSection);

		const signInButtons = await screen.findAllByRole('button', { name: 'Sign in' });
		expect(signInButtons).toHaveLength(2);

		await fireEvent.click(signInButtons[0]);
		expect(providersApi.launchAuthLogin).toHaveBeenCalledWith('claude');

		expect(screen.getByText('opencode auth login')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'More providers' }));
		expect(await screen.findByText('amp login')).toBeTruthy();
		expect(openSpy).not.toHaveBeenCalled();

		openSpy.mockRestore();
	});
});
