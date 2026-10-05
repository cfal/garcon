import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type {
	ScheduledPrompt,
	ScheduledPromptRunLogEntry,
	ScheduledPromptSchedule,
} from '$shared/scheduled-prompts';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import ScheduledPromptRow from '../ScheduledPromptRow.svelte';

function makePrompt(schedule: ScheduledPromptSchedule): ScheduledPrompt {
	return {
		id: 'prompt-1',
		schedule,
		target: { type: 'existing-chat', chatId: '123', busyBehavior: 'skip' },
		prompt: 'Review the build',
		createdAt: '2030-01-01T00:00:00.000Z',
		updatedAt: '2030-01-01T00:00:00.000Z',
	};
}

interface RowOptions {
	executorLabel?: string;
	existingChat?: Pick<ChatSessionRecord, 'id' | 'title'>;
	lastRun?: ScheduledPromptRunLogEntry;
	lastRunChatId?: string | null;
	onOpenChat?: (chatId: string) => void;
}

function renderRow(scheduledPrompt: ScheduledPrompt, currentTime: Date, options: RowOptions = {}) {
	return render(ScheduledPromptRow, {
		scheduledPrompt,
		currentTime,
		...options,
		index: 0,
		total: 1,
		onEdit: vi.fn(),
		onRemove: vi.fn(),
		onMoveUp: vi.fn(),
		onMoveDown: vi.fn(),
	});
}

function slotText(container: HTMLElement, slot: string): string {
	return (
		container
			.querySelector(`[data-slot="${slot}"]`)
			?.textContent?.replace(/\s+/g, ' ')
			.trim() ?? ''
	);
}

describe('ScheduledPromptRow', () => {
	it.each([
		['<garcon-schedule-action />', 'Scheduled action'],
		[
			'<garcon-schedule-action>\nReview A &amp; B\nSecond line\n</garcon-schedule-action>',
			'Review A & B',
		],
		[
			'<garcon-schedule-action>\nMalformed &unknown;\n</garcon-schedule-action>',
			'<garcon-schedule-action>',
		],
	])('renders the action title for %s', (prompt, title) => {
		renderRow(
			{ ...makePrompt({ type: 'once', nextRunAt: '2030-01-01T04:00:00.000Z' }), prompt },
			new Date('2030-01-01T00:00:00.000Z'),
		);
		expect(screen.getByRole('heading', { name: title })).toBeTruthy();
	});
	it('shows new-chat agent and tags below the target row', () => {
		const scheduledPrompt: ScheduledPrompt = {
			...makePrompt({ type: 'once', nextRunAt: '2030-01-01T04:03:59.000Z' }),
			target: {
				type: 'new-chat',
				agentId: 'codex',
				projectPath: '/workspace/project',
				model: 'gpt-5',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
				permissionMode: 'acceptEdits',
				thinkingMode: 'high',
				agentSettingsById: {
					codex: { ownerId: 'codex', schemaVersion: 1, values: {} },
				},
				tags: ['qa', 'review-needed', 'frontend'],
				preambleChoice: { mode: 'defaults' },
			},
		};

		renderRow(scheduledPrompt, new Date('2030-01-01T00:00:00.000Z'));

		const target = screen.getByText('New chat in project');
		const agent = screen.getByText('Codex');
		expect(target.closest('[data-slot="scheduled-prompt-target"]')?.getAttribute('title')).toBe(
			'/workspace/project',
		);
		expect(screen.getByText('qa')).toBeTruthy();
		expect(screen.getByText('review-needed')).toBeTruthy();
		expect(screen.getByText('+1')).toBeTruthy();
		expect(screen.getByText('gpt-5')).toBeTruthy();
		expect(screen.queryByText(/preambles/)).toBeNull();
		expect(target.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('shows an explicit preamble selection but not the automatic default', () => {
		const scheduledPrompt = makePrompt({ type: 'once', nextRunAt: '2030-01-01T04:00:00.000Z' });
		renderRow(
			{
				...scheduledPrompt,
				target: {
					type: 'new-chat',
					agentId: 'codex',
					projectPath: '/workspace/project/',
					model: 'gpt-5',
					apiProviderId: null,
					modelEndpointId: null,
					modelProtocol: null,
					permissionMode: 'default',
					thinkingMode: 'none',
					agentSettingsById: {},
					tags: [],
					preambleChoice: { mode: 'explicit', orderedPreambleIds: ['a', 'b'] },
				},
			},
			new Date('2030-01-01T00:00:00.000Z'),
		);

		expect(screen.getByText('2 preambles selected')).toBeTruthy();
		expect(screen.getByText('New chat in project')).toBeTruthy();
	});

	it('opens the target chat of an existing-chat prompt', async () => {
		const onOpenChat = vi.fn();
		renderRow(
			makePrompt({ type: 'once', nextRunAt: '2030-01-01T04:00:00.000Z' }),
			new Date('2030-01-01T00:00:00.000Z'),
			{ existingChat: { id: '123', title: 'Daily review' }, onOpenChat },
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Daily review' }));

		expect(onOpenChat).toHaveBeenCalledWith('123');
	});

	it('flags an existing-chat prompt whose chat is gone', () => {
		renderRow(
			makePrompt({ type: 'once', nextRunAt: '2030-01-01T04:00:00.000Z' }),
			new Date('2030-01-01T00:00:00.000Z'),
		);

		expect(screen.getByText('Missing chat: 123')).toBeTruthy();
	});

	it('summarizes the last run and links the chat it created', async () => {
		const onOpenChat = vi.fn();
		const lastRun: ScheduledPromptRunLogEntry = {
			at: new Date(2030, 0, 1, 8, 0, 0, 0).toISOString(),
			scheduledPromptId: 'prompt-1',
			promptLabel: 'Review the build',
			outcome: 'created-chat',
			chatId: '456',
			message: 'Prompt executed successfully; created chat 456.',
		};
		const { container } = renderRow(
			makePrompt({ type: 'once', nextRunAt: '2030-01-03T04:00:00.000Z' }),
			new Date(2030, 0, 1, 9, 0, 0, 0),
			{ lastRun, lastRunChatId: '456', onOpenChat },
		);

		expect(slotText(container, 'scheduled-prompt-last-run')).toMatch(
			/^Last run Today at .+: Started a new chat Open chat$/,
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
		expect(onOpenChat).toHaveBeenCalledWith('456');
	});

	it('explains a failed last run and omits the row until a run is recorded', () => {
		const prompt = makePrompt({ type: 'once', nextRunAt: '2030-01-03T04:00:00.000Z' });
		const now = new Date(2030, 0, 1, 9, 0, 0, 0);
		const first = renderRow(prompt, now);
		expect(first.container.querySelector('[data-slot="scheduled-prompt-last-run"]')).toBeNull();
		first.unmount();

		const { container } = renderRow(prompt, now, {
			lastRun: {
				at: new Date(2029, 11, 31, 8, 0, 0, 0).toISOString(),
				scheduledPromptId: 'prompt-1',
				promptLabel: 'Review the build',
				outcome: 'failed',
				chatId: null,
				message: 'Prompt failed: Chat is unavailable.',
			},
		});
		const lastRunRow = container.querySelector('[data-slot="scheduled-prompt-last-run"]');
		expect(lastRunRow?.textContent).toMatch(/Last run Yesterday at .+: Failed/);
		expect(lastRunRow?.getAttribute('title')).toBe('Prompt failed: Chat is unavailable.');
		expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull();
	});

	it('shows the executor as a pill above the title', () => {
		const scheduledPrompt = makePrompt({ type: 'once', nextRunAt: '2030-01-01T04:00:00.000Z' });
		const rendered = renderRow(scheduledPrompt, new Date('2030-01-01T00:00:00.000Z'), {
			executorLabel: 'Build worker',
		});

		const pill = rendered.container.querySelector('[data-slot="scheduled-prompt-executor"]');
		expect(pill?.getAttribute('title')).toBe('Executor: Build worker');
		expect(screen.getByText('Executor: Build worker')).toBeTruthy();
		expect(pill?.textContent).toContain('Build worker');
		const heading = screen.getByRole('heading', { name: 'Review the build' });
		expect(pill!.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		rendered.unmount();
		const withoutExecutor = renderRow(scheduledPrompt, new Date('2030-01-01T00:00:00.000Z'));
		expect(
			withoutExecutor.container.querySelector('[data-slot="scheduled-prompt-executor"]'),
		).toBeNull();
	});

	it('shows the remaining time for a one-off scheduled prompt', () => {
		const { container } = renderRow(
			makePrompt({ type: 'once', nextRunAt: new Date(2030, 0, 1, 4, 3, 59, 0).toISOString() }),
			new Date(2030, 0, 1, 0, 0, 0, 0),
		);

		expect(slotText(container, 'scheduled-prompt-cadence')).toBe('One off');
		expect(slotText(container, 'scheduled-prompt-next-run')).toMatch(/^Today at .+ · in 4h3m$/);
	});

	it('shows and updates the next-run countdown for a recurring scheduled prompt', async () => {
		const scheduledPrompt = makePrompt({
			type: 'recurring',
			intervalMinutes: 120,
			nextRunAt: '2030-01-01T02:03:00.000Z',
			endAt: null,
		});
		const { container, rerender } = renderRow(
			scheduledPrompt,
			new Date('2030-01-01T00:00:00.000Z'),
		);

		expect(slotText(container, 'scheduled-prompt-next-run')).toMatch(/ · in 2h3m$/);

		await rerender({
			scheduledPrompt,
			currentTime: new Date('2030-01-01T02:03:00.000Z'),
			index: 0,
			total: 1,
			onEdit: vi.fn(),
			onRemove: vi.fn(),
			onMoveUp: vi.fn(),
			onMoveDown: vi.fn(),
		});

		expect(slotText(container, 'scheduled-prompt-next-run')).toMatch(/ · due now$/);
	});

	it.each([
		{ intervalMinutes: 1, label: 'Every minute' },
		{ intervalMinutes: 5, label: 'Every 5 minutes' },
		{ intervalMinutes: 59, label: 'Every 59 minutes' },
		{ intervalMinutes: 90, label: 'Every 90 minutes' },
		{ intervalMinutes: 60, label: 'Hourly' },
		{ intervalMinutes: 300, label: 'Every 5 hours' },
		{ intervalMinutes: 1440, label: 'Daily' },
		{ intervalMinutes: 2880, label: 'Every 2 days' },
		{ intervalMinutes: 10080, label: 'Weekly' },
	])('labels a $intervalMinutes-minute cadence as "$label"', ({ intervalMinutes, label }) => {
		const { container } = renderRow(
			makePrompt({
				type: 'recurring',
				intervalMinutes,
				nextRunAt: '2030-01-01T02:03:00.000Z',
				endAt: null,
			}),
			new Date('2030-01-01T00:00:00.000Z'),
		);

		expect(slotText(container, 'scheduled-prompt-cadence')).toBe(label);
	});

	it('shows when a recurring prompt ends', () => {
		const { container } = renderRow(
			makePrompt({
				type: 'recurring',
				intervalMinutes: 1440,
				nextRunAt: '2030-01-01T02:03:00.000Z',
				endAt: new Date(2030, 1, 14, 9, 0, 0, 0).toISOString(),
			}),
			new Date('2030-01-01T00:00:00.000Z'),
		);

		expect(slotText(container, 'scheduled-prompt-cadence')).toMatch(/^Daily until .*2030$/);
	});

	it('keeps reorder and remove behind the prompt actions menu', () => {
		renderRow(
			makePrompt({ type: 'once', nextRunAt: '2030-01-01T04:00:00.000Z' }),
			new Date('2030-01-01T00:00:00.000Z'),
		);

		expect(screen.getByRole('button', { name: 'Edit prompt' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Prompt actions' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Remove prompt' })).toBeNull();
	});
});
