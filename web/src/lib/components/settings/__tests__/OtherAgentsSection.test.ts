import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import OtherAgentsSection, { type OtherAgentsAuth } from '../OtherAgentsSection.svelte';

const SIGNED_OUT = { authenticated: false, canReauth: true, label: '', loading: false, error: null };

function authDouble(loginAgents: readonly string[]) {
	return {
		authFor: () => SIGNED_OUT,
		readinessFor: () => undefined,
		supportsAuthLogin: (agentId: string) => loginAgents.includes(agentId),
		deviceAuthFor: () => undefined,
		isLoginPending: () => false,
		handleLogin: vi.fn(async () => undefined),
		completeLogin: vi.fn(async () => undefined),
	} satisfies OtherAgentsAuth;
}

describe('OtherAgentsSection', () => {
	it('offers in-app sign-in only for agents whose integration supports it', async () => {
		const settingsAuth = authDouble(['antigravity']);
		render(OtherAgentsSection, { settingsAuth });

		const signIn = screen.getAllByRole('button', { name: 'Sign in' });
		expect(signIn).toHaveLength(1);
		await fireEvent.click(signIn[0]!);
		expect(settingsAuth.handleLogin).toHaveBeenCalledWith('antigravity');
	});

	it('keeps CLI login instructions for agents without in-app sign-in', async () => {
		render(OtherAgentsSection, { settingsAuth: authDouble([]) });

		expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
		await fireEvent.click(screen.getByText('Antigravity'));
		expect(screen.getByText('agy acp --login')).toBeTruthy();
	});
});
