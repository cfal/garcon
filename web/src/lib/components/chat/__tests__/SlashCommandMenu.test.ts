import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/commands.js', () => ({
	getSlashCommands: vi.fn(),
}));

import { getSlashCommands } from '$lib/api/commands.js';
import SlashCommandMenuTestHost from './SlashCommandMenuTestHost.svelte';

// An empty projectPath skips agent discovery, so these cases exercise the
// always-present built-in commands without hitting the network.
const baseProps = {
	agent: 'claude',
	projectPath: '',
	supportsFork: true,
	canScheduleIn: true,
};
const mockedGetSlashCommands = vi.mocked(getSlashCommands);

describe('SlashCommandMenu', () => {
	beforeEach(() => {
		mockedGetSlashCommands.mockReset();
	});

	it('lists the built-in compact command matching the query', () => {
		render(SlashCommandMenuTestHost, {
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
		render(SlashCommandMenuTestHost, {
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

	it('lists the built-in rename command', () => {
		render(SlashCommandMenuTestHost, {
			...baseProps,
			isVisible: true,
			query: 'rename',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(screen.getByText('/rename')).toBeTruthy();
		expect(screen.getByText('Rename the current chat')).toBeTruthy();
	});

	it('lists the Codex goal command only for Codex', () => {
		render(SlashCommandMenuTestHost, {
			...baseProps,
			agent: 'codex',
			isVisible: true,
			query: 'goal',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(screen.getByText('/goal')).toBeTruthy();
		expect(screen.getByText('Set a Codex goal and start working toward it')).toBeTruthy();
	});

	it('hides the Codex goal command for other agents', () => {
		render(SlashCommandMenuTestHost, {
			...baseProps,
			isVisible: true,
			query: 'goal',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(screen.queryByText('/goal')).toBeNull();
	});

	it('lists the steer command only for Codex', () => {
		const { unmount } = render(SlashCommandMenuTestHost, {
			...baseProps,
			agent: 'codex',
			isVisible: true,
			query: 'steer',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(screen.getByText('/steer')).toBeTruthy();
		expect(screen.getByText('Send guidance to the active Codex turn immediately')).toBeTruthy();
		unmount();

		render(SlashCommandMenuTestHost, {
			...baseProps,
			isVisible: true,
			query: 'steer',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});
		expect(screen.queryByText('/steer')).toBeNull();
	});

	it('hides the fork command when not supported', () => {
		render(SlashCommandMenuTestHost, {
			...baseProps,
			supportsFork: false,
			isVisible: true,
			query: '',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(screen.queryByText('/fork')).toBeNull();
	});

	it('shows /in for existing chats and hides it for drafts', () => {
		const { unmount } = render(SlashCommandMenuTestHost, {
			...baseProps,
			isVisible: true,
			query: 'in',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});
		expect(screen.getByText('/in')).toBeTruthy();
		expect(screen.getByText('Schedule a prompt in this chat after a delay')).toBeTruthy();
		unmount();

		render(SlashCommandMenuTestHost, {
			...baseProps,
			canScheduleIn: false,
			isVisible: true,
			query: 'in',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});
		expect(screen.queryByText('/in')).toBeNull();
	});

	it('deduplicates an agent-discovered in command behind the built-in', async () => {
		mockedGetSlashCommands.mockResolvedValue([
			{ name: 'in', source: 'command', description: 'Agent command' },
		]);
		render(SlashCommandMenuTestHost, {
			...baseProps,
			projectPath: '/repo',
			isVisible: true,
			query: 'in',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(await screen.findByText('/in')).toBeTruthy();
		expect(screen.getAllByText('/in')).toHaveLength(1);
		expect(screen.queryByText('Agent command')).toBeNull();
	});

	it('hides an agent-discovered in command for draft chats', async () => {
		mockedGetSlashCommands.mockResolvedValue([
			{ name: 'in', source: 'command', description: 'Agent command' },
		]);
		render(SlashCommandMenuTestHost, {
			...baseProps,
			projectPath: '/repo',
			canScheduleIn: false,
			isVisible: true,
			query: 'in',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		await waitFor(() => expect(mockedGetSlashCommands).toHaveBeenCalled());
		expect(screen.queryByText('/in')).toBeNull();
		expect(screen.queryByText('Agent command')).toBeNull();
	});

	it('keeps discovered Codex skills beyond the old visible slice filterable', async () => {
		mockedGetSlashCommands.mockResolvedValue(
			Array.from({ length: 12 }, (_, index) => ({
				name: `skill-${index}`,
				source: 'skill' as const,
			})),
		);

		render(SlashCommandMenuTestHost, {
			agent: 'codex',
			projectPath: '/repo',
			supportsFork: true,
			canScheduleIn: true,
			isVisible: true,
			query: 'skill-11',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		expect(await screen.findByText('/skill-11')).toBeTruthy();
		expect(mockedGetSlashCommands).toHaveBeenCalledWith(
			{ agent: 'codex', chatId: null, projectPath: '/repo' },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('renders a bounded skill window and reveals later skills by scrolling', async () => {
		mockedGetSlashCommands.mockResolvedValue(
			Array.from({ length: 200 }, (_, index) => ({
				name: `skill-${index}`,
				source: 'skill' as const,
			})),
		);

		render(SlashCommandMenuTestHost, {
			agent: 'codex',
			projectPath: '/repo',
			supportsFork: true,
			canScheduleIn: true,
			isVisible: true,
			query: '',
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		await screen.findByText('/skill-0');
		expect(screen.getAllByRole('option').length).toBeLessThan(20);
		expect(screen.queryByText('/skill-100')).toBeNull();

		const listbox = screen.getByRole('listbox');
		listbox.scrollTop = 106 * 48;
		await fireEvent.scroll(listbox);

		expect(await screen.findByText('/skill-100')).toBeTruthy();
		expect(screen.getAllByRole('option').length).toBeLessThan(20);
	});

	it('selects a command on click', async () => {
		const onSelect = vi.fn();
		render(SlashCommandMenuTestHost, {
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
		const { component } = render(SlashCommandMenuTestHost, {
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
		render(SlashCommandMenuTestHost, {
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
