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

	it('requests card expansion when sign-in from collapsed header yields device auth', async () => {
		const onOpenChange = vi.fn();
		let resolveLogin!: () => void;
		const onLogin = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveLogin = resolve;
				}),
		);
		const { rerender } = render(AgentCard, {
			agentId: 'codex',
			agentName: 'Codex',
			auth: { authenticated: false, canReauth: true, label: '', loading: false, error: null },
			open: false,
			onLogin,
			onOpenChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
		await rerender({ deviceAuth: { url: 'https://example.test/device', code: 'AAAA-BBBBB' } });
		resolveLogin();
		await vi.waitFor(() => {
			expect(onOpenChange).toHaveBeenCalledWith(true);
		});
	});

	it('does not request expansion when sign-in yields no device auth', async () => {
		const onOpenChange = vi.fn();
		const onLogin = vi.fn(() => Promise.resolve());
		render(AgentCard, {
			agentId: 'claude',
			agentName: 'Claude',
			auth: { authenticated: false, canReauth: true, label: '', loading: false, error: null },
			open: false,
			onLogin,
			onOpenChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
		await vi.waitFor(() => {
			expect(onLogin).toHaveBeenCalled();
		});
		expect(onOpenChange).not.toHaveBeenCalled();
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
