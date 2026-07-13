import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SurfaceTabRail from './SurfaceTabRail.svelte';

describe('SurfaceTabRail', () => {
	it('keeps Chat first and supports manual keyboard tab activation', async () => {
		const onSelect = vi.fn();
		const onFocus = vi.fn();
		render(SurfaceTabRail, {
			host: 'main',
			hostState: {
				order: ['singleton:chat', 'singleton:git', 'singleton:pull-requests'],
				activeId: 'singleton:chat',
				mru: ['singleton:chat', 'singleton:git', 'singleton:pull-requests'],
			},
			labelFor: (surfaceId) => surfaceId.replace('singleton:', ''),
			onSelect,
			onFocus,
		});

		const tabs = screen.getAllByRole('tab');
		expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['chat', 'git', 'pull-requests']);
		expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');

		tabs[0].focus();
		await fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
		expect(document.activeElement).toBe(tabs[1]);
		expect(onSelect).not.toHaveBeenCalled();

		await fireEvent.keyDown(tabs[1], { key: 'Enter' });
		expect(onSelect).toHaveBeenCalledWith('singleton:git');
		expect(onFocus).toHaveBeenCalledWith('singleton:git');
	});
});
