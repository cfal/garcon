import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SubagentManagementControl from '../SubagentManagementControl.svelte';
import type { SubagentManagementModel } from '$lib/chat/transcript/subagent-management.js';

function makeModel(): SubagentManagementModel {
	return {
		entries: [
			{
				id: 'root',
				kind: 'root',
				name: 'Main chat',
				status: 'running',
				statusLabel: 'Running',
				model: 'gpt-5',
			},
			{
				id: 'review-auth',
				kind: 'subagent',
				name: 'review-auth',
				status: 'waiting',
				statusLabel: 'Waiting',
				model: 'gpt-5.5',
				lastActionLabel: 'Waiting',
				anchorId: 'tool-input-tool-subagent-1',
			},
		],
		subagents: [
			{
				id: 'review-auth',
				kind: 'subagent',
				name: 'review-auth',
				status: 'waiting',
				statusLabel: 'Waiting',
				model: 'gpt-5.5',
				lastActionLabel: 'Waiting',
				anchorId: 'tool-input-tool-subagent-1',
			},
		],
	};
}

describe('SubagentManagementControl', () => {
	it('collapses to an Agents trigger showing the subagent count', () => {
		const { container } = render(SubagentManagementControl, { model: makeModel() });

		const trigger = screen.getByRole('button', { name: /Agents/ });
		expect(within(trigger).getByText('1')).toBeTruthy();
		expect(trigger.classList).toContain('border-transparent');
		expect(container.querySelector('.border-b')).toBeNull();
		// Entries stay hidden until the popover is opened.
		expect(screen.queryByText('Main chat')).toBeNull();
	});

	it('reveals root and subagent entries when opened', async () => {
		render(SubagentManagementControl, { model: makeModel() });

		const trigger = screen.getByRole('button', { name: /Agents/ });
		await fireEvent.click(trigger);

		expect(await screen.findByText('Main chat')).toBeTruthy();
		expect(screen.getByRole('button', { name: /review-auth/ })).toBeTruthy();
		expect(trigger.classList).toContain('bg-chat-tabs-active');
	});

	it('jumps to the originating tool event when a subagent is selected', async () => {
		const onJumpToTool = vi.fn();
		render(SubagentManagementControl, { model: makeModel(), onJumpToTool });

		await fireEvent.click(screen.getByRole('button', { name: /Agents/ }));
		await fireEvent.click(await screen.findByRole('button', { name: /review-auth/ }));

		expect(onJumpToTool).toHaveBeenCalledWith('tool-input-tool-subagent-1');
		await waitFor(() => expect(screen.queryByText('Main chat')).toBeNull());
	});

	it('renders nothing without subagents', () => {
		const model = makeModel();
		model.entries = model.entries.filter((entry) => entry.kind === 'root');
		model.subagents = [];

		const { container } = render(SubagentManagementControl, { model });

		expect(container.firstElementChild).toBeNull();
	});
});
