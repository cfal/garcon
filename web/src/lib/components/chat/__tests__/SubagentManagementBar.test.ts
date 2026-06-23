import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SubagentManagementBar from '../SubagentManagementBar.svelte';
import type { SubagentManagementModel } from '$lib/chat/subagent-management';

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
	it('renders root and subagent entries', () => {
		render(SubagentManagementBar, { model: makeModel() });

		expect(screen.getByText('Agents')).toBeTruthy();
		expect(screen.getByText('Main chat')).toBeTruthy();
		expect(screen.getByRole('button', { name: /review-auth/ })).toBeTruthy();
	});

	it('jumps to the originating tool event when a subagent is selected', async () => {
		const onJumpToTool = vi.fn();
		render(SubagentManagementBar, { model: makeModel(), onJumpToTool });

		await fireEvent.click(screen.getByRole('button', { name: /review-auth/ }));

		expect(onJumpToTool).toHaveBeenCalledWith('tool-input-tool-subagent-1');
	});
});
