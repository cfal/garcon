import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SlashCommandMenu from '../SlashCommandMenu.svelte';

// An empty projectPath skips agent discovery, so these cases exercise the
// always-present built-in commands without hitting the network.
const baseProps = { agent: 'claude', projectPath: '', supportsFork: true };

describe('SlashCommandMenu', () => {
	it('lists the built-in compact command matching the query', () => {
		render(SlashCommandMenu, {
			...baseProps,
			isVisible: true,
			query: 'comp',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(screen.getByText('/compact')).toBeTruthy();
		expect(screen.getByText('Summarize the conversation to free up context')).toBeTruthy();
	});

	it('lists the built-in fork command when supported', () => {
		render(SlashCommandMenu, {
			...baseProps,
			supportsFork: true,
			isVisible: true,
			query: 'fork',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(screen.getByText('/fork')).toBeTruthy();
		expect(screen.getByText('Fork the conversation into a new chat')).toBeTruthy();
	});

	it('hides the fork command when not supported', () => {
		render(SlashCommandMenu, {
			...baseProps,
			supportsFork: false,
			isVisible: true,
			query: '',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(screen.queryByText('/fork')).toBeNull();
	});

	it('selects a command on click', async () => {
		const onSelect = vi.fn();
		render(SlashCommandMenu, {
			...baseProps,
			isVisible: true,
			query: '',
			onSelect,
			onClose: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /\/compact/ }));

		expect(onSelect).toHaveBeenCalledWith('compact');
	});

	it('selects the highlighted command via the keyboard handler', () => {
		const onSelect = vi.fn();
		const { component } = render(SlashCommandMenu, {
			...baseProps,
			isVisible: true,
			query: '',
			onSelect,
			onClose: vi.fn(),
		});

		const handled = component.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));

		expect(handled).toBe(true);
		expect(onSelect).toHaveBeenCalledWith('compact');
	});

	it('shows the empty state when nothing matches', () => {
		render(SlashCommandMenu, {
			...baseProps,
			isVisible: true,
			query: 'zzz',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(screen.queryByRole('option')).toBeNull();
		expect(screen.getByText('No matching commands')).toBeTruthy();
	});
});
