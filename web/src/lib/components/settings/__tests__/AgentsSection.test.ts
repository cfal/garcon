import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentsSection from '../AgentsSection.svelte';
import * as providersApi from '$lib/api/providers.js';

vi.mock('$lib/api/providers.js', () => ({
	getAuthStatus: vi.fn(),
	launchAuthLogin: vi.fn()
}));

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('AgentsSection', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

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

	it('cancels in-flight auth polling when the component unmounts', async () => {
		vi.useFakeTimers();
		const deferredAuth = createDeferred<{ authenticated: boolean; canReauth: boolean; label: string }>();
		let claudeChecks = 0;

		vi.mocked(providersApi.getAuthStatus).mockImplementation(async (provider) => {
			if (provider === 'claude') {
				claudeChecks += 1;
				if (claudeChecks === 3) {
					return deferredAuth.promise;
				}
				return { authenticated: false, canReauth: true, label: '' };
			}

			if (provider === 'codex') {
				return { authenticated: false, canReauth: true, label: '' };
			}

			return { authenticated: false, canReauth: false, label: '' };
		});
		vi.mocked(providersApi.launchAuthLogin).mockResolvedValue({
			launched: true,
			alreadyRunning: false,
		});

		const { unmount } = render(AgentsSection);
		const signInButtons = await screen.findAllByRole('button', { name: 'Sign in' });

		await fireEvent.click(signInButtons[0]);
		expect(claudeChecks).toBe(2);

		await vi.advanceTimersByTimeAsync(1500);
		expect(claudeChecks).toBe(3);

		unmount();
		deferredAuth.resolve({ authenticated: false, canReauth: true, label: '' });
		await Promise.resolve();

		await vi.advanceTimersByTimeAsync(1500);
		expect(claudeChecks).toBe(3);
	});
});
