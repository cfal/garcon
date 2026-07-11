import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduledTask, ScheduledTaskSchedule } from '$shared/scheduled-tasks';
import ScheduledTaskRow from '../ScheduledTaskRow.svelte';

function makeTask(schedule: ScheduledTaskSchedule): ScheduledTask {
	return {
		id: 'task-1',
		schedule,
		target: { type: 'existing-chat', chatId: '123', busyBehavior: 'skip' },
		prompt: 'Review the build',
		createdAt: '2030-01-01T00:00:00.000Z',
		updatedAt: '2030-01-01T00:00:00.000Z',
	};
}

function renderRow(task: ScheduledTask, currentTime: Date) {
	return render(ScheduledTaskRow, {
		task,
		currentTime,
		index: 0,
		total: 1,
		onEdit: vi.fn(),
		onRemove: vi.fn(),
		onMoveUp: vi.fn(),
		onMoveDown: vi.fn(),
	});
}

describe('ScheduledTaskRow', () => {
	it('shows the remaining time for a one-off task', () => {
		renderRow(
			makeTask({ type: 'once', nextRunAt: '2030-01-01T04:03:59.000Z' }),
			new Date('2030-01-01T00:00:00.000Z'),
		);

		expect(screen.getByText('(in 4h3m)')).toBeTruthy();
	});

	it('shows and updates the next-run countdown for a recurring task', async () => {
		const task = makeTask({
			type: 'recurring',
			intervalDays: 2,
			nextRunAt: '2030-01-01T02:03:00.000Z',
			endAt: null,
		});
		const { rerender } = renderRow(task, new Date('2030-01-01T00:00:00.000Z'));

		expect(screen.getByText('(next run in 2h3m)')).toBeTruthy();

		await rerender({
			task,
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
