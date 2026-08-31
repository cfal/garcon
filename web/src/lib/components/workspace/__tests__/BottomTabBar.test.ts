import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import BottomTabBar from '../BottomTabBar.svelte';

afterEach(cleanup);

describe('BottomTabBar', () => {
	it('presents Work Map as a dedicated current mobile destination', async () => {
		const onTabChange = vi.fn();
		render(BottomTabBar, {
			activeItem: 'work-map',
			pullRequestsAvailable: false,
			onTabChange,
			onMenuClick: vi.fn(),
		});

		const map = screen.getByRole('button', { name: m.workspace_surface_work_map_short() });
		expect(map.getAttribute('aria-current')).toBe('page');
		expect(screen.queryByRole('button', { name: m.sidebar_navigation_pull_requests() })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_navigation_chat() }));
		expect(onTabChange).toHaveBeenCalledWith('chat');
	});
});
