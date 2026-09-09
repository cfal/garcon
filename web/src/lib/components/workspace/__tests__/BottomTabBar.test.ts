import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import BottomTabBar from '../BottomTabBar.svelte';

afterEach(cleanup);

describe('BottomTabBar', () => {
	it.each([
		{ kind: 'chat-map', label: m.workspace_surface_chat_map_short },
		{ kind: 'chat-canvas', label: m.workspace_surface_chat_canvas },
	] as const)('presents $kind as a dedicated mobile destination', async ({ kind, label }) => {
		const onTabChange = vi.fn();
		render(BottomTabBar, {
			activeItem: kind,
			pullRequestsAvailable: false,
			onTabChange,
			onMenuClick: vi.fn(),
		});

		const destination = screen.getByRole('button', { name: label() });
		expect(destination.getAttribute('aria-current')).toBe('page');
		expect(screen.queryByRole('button', { name: m.sidebar_navigation_pull_requests() })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_navigation_chat() }));
		expect(onTabChange).toHaveBeenCalledWith('chat');
		await fireEvent.click(destination);
		expect(onTabChange).toHaveBeenLastCalledWith(kind);
	});
});
