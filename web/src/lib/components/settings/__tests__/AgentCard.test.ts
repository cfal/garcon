import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AgentCard from '../AgentCard.svelte';

type AuthStatus = {
	authenticated: boolean;
	canReauth: boolean;
	label: string;
	loading: boolean;
	error: string | null;
};

function renderCard(
	auth: AuthStatus,
	open = true,
	options: {
		onCompleteLogin?: (code: string) => void;
		pending?: boolean;
		deviceAuth?: { url: string; code?: string; needsCode?: boolean };
	} = {},
) {
	render(AgentCard, {
		agentId: 'claude',
		agentName: 'Claude',
		auth,
		open,
		onLogin: vi.fn(),
		...options,
	});
}

describe('AgentCard', () => {
	it('renders a single Sign in button when unauthenticated and expanded', () => {
		renderCard(
			{ authenticated: false, canReauth: true, label: '', loading: false, error: null },
			true,
		);

		expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
	});

	it('renders Sign in only when authenticated and expanded', () => {
		renderCard(
			{
				authenticated: true,
				canReauth: true,
				label: 'test@example.com',
				loading: false,
				error: null,
			},
			true,
		);

		expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
	});

	it('submits browser auth code with Enter when enabled', async () => {
		const onCompleteLogin = vi.fn();
		renderCard(
			{ authenticated: false, canReauth: true, label: '', loading: false, error: null },
			true,
			{
				deviceAuth: { url: 'https://example.test/login', needsCode: true },
				onCompleteLogin,
			},
		);

		const input = screen.getByPlaceholderText('Paste authorization code');
		await fireEvent.input(input, { target: { value: ' auth-code ' } });
		await fireEvent.keyDown(input, { key: 'Enter' });

		expect(onCompleteLogin).toHaveBeenCalledWith('auth-code');
	});

	it('does not submit browser auth code with Enter while pending', async () => {
		const onCompleteLogin = vi.fn();
		renderCard(
			{ authenticated: false, canReauth: true, label: '', loading: false, error: null },
			true,
			{
				deviceAuth: { url: 'https://example.test/login', needsCode: true },
				onCompleteLogin,
				pending: true,
			},
		);

		const input = screen.getByPlaceholderText('Paste authorization code');
		await fireEvent.input(input, { target: { value: 'auth-code' } });
		await fireEvent.keyDown(input, { key: 'Enter' });

		expect(screen.getByRole('button', { name: 'Submit code' }).hasAttribute('disabled')).toBe(true);
		expect(onCompleteLogin).not.toHaveBeenCalled();
	});
});
