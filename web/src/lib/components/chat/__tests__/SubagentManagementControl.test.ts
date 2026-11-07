import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SubagentManagementControl from '../SubagentManagementControl.svelte';
import type { SubagentManagementModel } from '$lib/chat/transcript/subagent-management.js';
import type { DisplaySummaryPaging } from '$lib/chat/transcript/display-summary-paging.js';

function makePaging(overrides: Partial<DisplaySummaryPaging> = {}): DisplaySummaryPaging {
	return {
		loading: false,
		updating: false,
		stale: false,
		error: null,
		hasPrevious: false,
		hasNext: false,
		retry: vi.fn(async () => {}),
		next: vi.fn(async () => {}),
		previous: vi.fn(async () => {}),
		...overrides,
	};
}

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
				anchorOrdinal: 7,
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
				anchorOrdinal: 7,
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

	it('applies titlebar sizing without changing the popover surface', () => {
		render(SubagentManagementControl, {
			model: makeModel(),
			sizing: { controlHeightPx: 38, iconSizePx: 17, fontSizePx: 16 },
		});

		const trigger = screen.getByRole('button', { name: /Agents/ });
		expect(trigger.style.height).toBe('38px');
		expect(trigger.style.fontSize).toBe('calc(16px * var(--interface-font-scale, 1))');
		expect(trigger.querySelector('svg')?.getAttribute('style')).toContain('height: 17px');
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

		expect(onJumpToTool).toHaveBeenCalledWith(7);
		await waitFor(() => expect(screen.queryByText('Main chat')).toBeNull());
	});

	it('renders nothing without subagents', () => {
		const model = makeModel();
		model.entries = model.entries.filter((entry) => entry.kind === 'root');
		model.subagents = [];

		const { container } = render(SubagentManagementControl, { model });

		expect(container.firstElementChild).toBeNull();
	});

	it('keeps an empty summary hidden while loading and after it settles', async () => {
		const model = { entries: [], subagents: [] } satisfies SubagentManagementModel;
		const { container, rerender } = render(SubagentManagementControl, {
			model,
			paging: makePaging({ loading: true, updating: true }),
		});

		expect(container.firstElementChild).toBeNull();
		await rerender({ model, paging: makePaging() });
		expect(container.firstElementChild).toBeNull();
	});

	it('keeps existing agents available while their summary updates', async () => {
		render(SubagentManagementControl, {
			model: makeModel(),
			paging: makePaging({ loading: true, updating: true }),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Agents/ }));
		expect(await screen.findByRole('button', { name: /review-auth/ })).toBeTruthy();
		expect(screen.getByRole('status').textContent).toBe('Updating...');
	});

	it('keeps failed empty summaries accessible for retry', async () => {
		const paging = makePaging({ error: 'Synthetic summary failure' });
		render(SubagentManagementControl, { model: { entries: [], subagents: [] }, paging });

		await fireEvent.click(screen.getByRole('button', { name: /Agents/ }));
		expect(await screen.findByText('Synthetic summary failure')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(paging.retry).toHaveBeenCalledOnce();
	});
});
