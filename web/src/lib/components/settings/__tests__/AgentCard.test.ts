import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AgentCard from '../AgentCard.svelte';

type AuthStatus = {
	authenticated: boolean;
	canReauth: boolean;
	label: string;
	loading: boolean;
	error: string | null;
};

function renderCard(auth: AuthStatus, open = true) {
	render(AgentCard, {
		agentId: 'claude',
		agentName: 'Claude',
		auth,
		open,
		onLogin: vi.fn(),
	});
}

describe('AgentCard', () => {
	it('renders a single Sign in button when unauthenticated and expanded', () => {
		renderCard({ authenticated: false, canReauth: true, label: '', loading: false, error: null }, true);

		expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
	});

	it('renders Sign in only when authenticated and expanded', () => {
		renderCard({ authenticated: true, canReauth: true, label: 'test@example.com', loading: false, error: null }, true);

		expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
	});
});
