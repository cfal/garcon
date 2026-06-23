import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SlashCommandMenu from '../SlashCommandMenu.svelte';

describe('SlashCommandMenu', () => {
	it('lists the compact command matching the query', () => {
		render(SlashCommandMenu, {
			isVisible: true,
			query: 'comp',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(screen.getByText('/compact [focus]')).toBeTruthy();
		expect(screen.getByText('Summarize the conversation to free up context')).toBeTruthy();
	});

	it('selects a command on click', async () => {
		const onSelect = vi.fn();
		render(SlashCommandMenu, { isVisible: true, query: '', onSelect, onClose: vi.fn() });

		await fireEvent.click(screen.getByRole('button', { name: /\/compact/ }));

		expect(onSelect).toHaveBeenCalledWith('compact');
	});

	it('selects the highlighted command via the keyboard handler', () => {
		const onSelect = vi.fn();
		const { component } = render(SlashCommandMenu, {
			isVisible: true,
			query: '',
			onSelect,
			onClose: vi.fn(),
		});

		const handled = component.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));

		expect(handled).toBe(true);
		expect(onSelect).toHaveBeenCalledWith('compact');
	});

	it('renders nothing when there are no matches', () => {
		render(SlashCommandMenu, { isVisible: true, query: 'zzz', onSelect: vi.fn(), onClose: vi.fn() });

		expect(screen.queryByRole('listbox')).toBeNull();
	});
});
