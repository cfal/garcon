import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import BottomTabBar from '../BottomTabBar.svelte';

afterEach(cleanup);

describe('BottomTabBar', () => {
	it('keeps only the primary mobile destinations and routes their actions', async () => {
		const onTabChange = vi.fn();
		const onMenuClick = vi.fn();
		render(BottomTabBar, {
			activeItem: 'git',
			onTabChange,
			onMenuClick,
		});

		expect(screen.getAllByRole('button').map((button) => button.textContent?.trim())).toEqual([
			m.mobile_menu(),
			m.sidebar_navigation_chat(),
			m.sidebar_navigation_git(),
			m.sidebar_navigation_files(),
			m.sidebar_navigation_terminal(),
		]);
		expect(
			screen.getByRole('button', { name: m.sidebar_navigation_git() }).getAttribute('aria-current'),
		).toBe('page');

		await fireEvent.click(screen.getByRole('button', { name: m.mobile_menu() }));
		expect(onMenuClick).toHaveBeenCalledOnce();
		for (const [id, label] of [
			['chat', m.sidebar_navigation_chat()],
			['git', m.sidebar_navigation_git()],
			['files', m.sidebar_navigation_files()],
			['terminal', m.sidebar_navigation_terminal()],
		]) {
			await fireEvent.click(screen.getByRole('button', { name: label }));
			expect(onTabChange).toHaveBeenLastCalledWith(id);
		}
	});
});
