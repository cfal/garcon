import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AgentCard from '../AgentCard.svelte';

type AuthStatus = {
	authenticated: boolean;
	email: string | null;
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
	it('renders a single Login button when unauthenticated and expanded', () => {
		renderCard({ authenticated: false, email: null, loading: false, error: null }, true);

		expect(screen.getAllByRole('button', { name: 'Login' })).toHaveLength(1);
	});

	it('renders Re-login only when authenticated and expanded', () => {
		renderCard({ authenticated: true, email: 'test@example.com', loading: false, error: null }, true);

		expect(screen.getByRole('button', { name: 'Re-login' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Login' })).toBeNull();
	});
});
