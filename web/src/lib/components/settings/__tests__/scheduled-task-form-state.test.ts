import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskFormState } from '../scheduled-task-form-state.svelte';
import { localDateValue, localTimeValue } from '$lib/scheduling/local-schedule';
import type { ScheduledTask } from '$shared/scheduled-tasks';

function createForm(existingIds = new Set(['123'])): ScheduledTaskFormState {
	const sessions = {
		hasChat: (chatId: string) => existingIds.has(chatId),
		isDraft: () => false,
	};
	const form = new ScheduledTaskFormState({} as never, {} as never, sessions as never);
	form.startup.loadSettingsAndModels = vi.fn().mockResolvedValue(undefined);
	return form;
}

function existingTask(schedule: ScheduledTask['schedule']): ScheduledTask {
	return {
		id: 'task-a',
		schedule,
		target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
		prompt: 'Continue the work',
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
	};
}

describe('ScheduledTaskFormState', () => {
	it('uses one validation gate for missing chats and slash commands', () => {
		const existingIds = new Set<string>();
		const form = createForm(existingIds);
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		form.date = localDateValue(tomorrow);
		form.time = localTimeValue(tomorrow);
		form.targetType = 'existing-chat';
		form.existingChatId = '123';
		form.prompt = 'Continue the work';

		expect(form.canSave).toBe(false);
		existingIds.add('123');
		expect(form.canSave).toBe(true);
		form.prompt = '/compact first';
		expect(form.canSave).toBe(false);
	});

	it('reanchors a one-off task when it is changed to recurring', async () => {
		const form = createForm();
		const original = new Date(2030, 0, 20, 9, 0, 0, 0);
		await form.initialize(existingTask({ type: 'once', nextRunAt: original.toISOString() }));
		form.scheduleType = 'recurring';
		const now = new Date(2030, 0, 1, 8, 0, 0, 0);

		const definition = form.buildDefinition(now);

		expect(definition?.schedule.type).toBe('recurring');
		if (definition?.schedule.type !== 'recurring') throw new Error('Expected recurring schedule');
		expect(definition.schedule.firstRunAtUtc).toBe(
			new Date(2030, 0, 1, 9, 0, 0, 0).toISOString(),
		);
	});

	it('preserves an unchanged recurring UTC end instant', async () => {
		const form = createForm();
		const nextRunAt = new Date(2030, 0, 2, 9, 0, 0, 0).toISOString();
		const endAt = new Date(2030, 0, 10, 10, 0, 0, 0).toISOString();
		await form.initialize(
			existingTask({ type: 'recurring', intervalDays: 2, nextRunAt, endAt }),
		);

		const definition = form.buildDefinition(new Date(2030, 0, 1, 8, 0, 0, 0));

		expect(definition?.schedule.type).toBe('recurring');
		if (definition?.schedule.type !== 'recurring') throw new Error('Expected recurring schedule');
		expect(definition.schedule.endAtUtc).toBe(endAt);
	});
});
