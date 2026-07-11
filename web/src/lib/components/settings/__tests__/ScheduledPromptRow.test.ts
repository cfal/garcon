import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduledPrompt, ScheduledPromptSchedule } from '$shared/scheduled-prompts';
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

function renderRow(scheduledPrompt: ScheduledPrompt, currentTime: Date) {
	return render(ScheduledPromptRow, {
		scheduledPrompt,
		currentTime,
		index: 0,
		total: 1,
		onEdit: vi.fn(),
		onRemove: vi.fn(),
		onMoveUp: vi.fn(),
		onMoveDown: vi.fn(),
	});
}

describe('ScheduledPromptRow', () => {
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
				claudeThinkingMode: 'auto',
				ampAgentMode: 'smart',
				tags: ['qa', 'review-needed', 'frontend'],
			},
		};

		renderRow(scheduledPrompt, new Date('2030-01-01T00:00:00.000Z'));

		const target = screen.getByText('New chat: /workspace/project');
		const agent = screen.getByText('Codex');
		expect(screen.getByText('qa')).toBeTruthy();
		expect(screen.getByText('review-needed')).toBeTruthy();
		expect(screen.getByText('+1')).toBeTruthy();
		expect(target.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('shows the remaining time for a one-off scheduled prompt', () => {
		renderRow(
			makePrompt({ type: 'once', nextRunAt: '2030-01-01T04:03:59.000Z' }),
			new Date('2030-01-01T00:00:00.000Z'),
		);

		expect(screen.getByText('(in 4h3m)')).toBeTruthy();
	});

	it('shows and updates the next-run countdown for a recurring scheduled prompt', async () => {
		const scheduledPrompt = makePrompt({
			type: 'recurring',
			intervalDays: 2,
			nextRunAt: '2030-01-01T02:03:00.000Z',
			endAt: null,
		});
		const { rerender } = renderRow(scheduledPrompt, new Date('2030-01-01T00:00:00.000Z'));

		expect(screen.getByText('(next run in 2h3m)')).toBeTruthy();

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

		expect(screen.getByText('(next run due now)')).toBeTruthy();
		expect(screen.queryByText('(next run in 2h3m)')).toBeNull();
	});
});
