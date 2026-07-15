import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SubagentManagementBar from '../SubagentManagementBar.svelte';
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

describe('SubagentManagementBar', () => {
	it('collapses to an Agents trigger showing the subagent count', () => {
		render(SubagentManagementBar, { model: makeModel() });

		const trigger = screen.getByRole('button', { name: /Agents/ });
		expect(within(trigger).getByText('1')).toBeTruthy();
		// Entries stay hidden until the popover is opened.
		expect(screen.queryByText('Main chat')).toBeNull();
	});

	it('reveals root and subagent entries when opened', async () => {
		render(SubagentManagementBar, { model: makeModel() });

		await fireEvent.click(screen.getByRole('button', { name: /Agents/ }));

		expect(await screen.findByText('Main chat')).toBeTruthy();
		expect(screen.getByRole('button', { name: /review-auth/ })).toBeTruthy();
	});

	it('jumps to the originating tool event when a subagent is selected', async () => {
		const onJumpToTool = vi.fn();
		render(SubagentManagementBar, { model: makeModel(), onJumpToTool });

		await fireEvent.click(screen.getByRole('button', { name: /Agents/ }));
		await fireEvent.click(await screen.findByRole('button', { name: /review-auth/ }));

		expect(onJumpToTool).toHaveBeenCalledWith('tool-input-tool-subagent-1');
	});
});
