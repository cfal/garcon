import { describe, expect, it, vi } from 'vitest';
import { ScheduledPromptFormState } from '../scheduled-prompt-form-state.svelte';
import { localDateValue, localTimeValue } from '$lib/scheduling/local-schedule';
import type { ScheduledPrompt } from '$shared/scheduled-prompts';

function createForm(existingIds = new Set(['123'])): ScheduledPromptFormState {
	const sessions = {
		hasChat: (chatId: string) => existingIds.has(chatId),
		isDraft: () => false,
	};
	const modelCatalog = {
		getModels: () => [{ value: 'gpt-5', label: 'GPT-5' }],
		getDefaultModel: () => 'gpt-5',
		selectionValueFor: (_agentId: string, model: string) => model,
		selectionFor: () => ({
			model: 'gpt-5',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		}),
	};
	const form = new ScheduledPromptFormState(modelCatalog as never, {} as never, sessions as never);
	form.startup.loadSettingsAndModels = vi.fn().mockResolvedValue(undefined);
	return form;
}

function existingPrompt(schedule: ScheduledPrompt['schedule']): ScheduledPrompt {
	return {
		id: 'prompt-a',
		schedule,
		target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
		prompt: 'Continue the work',
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
	};
}

describe('ScheduledPromptFormState', () => {
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

	it('reanchors a one-off scheduled prompt when it is changed to recurring', async () => {
		const form = createForm();
		const original = new Date(2030, 0, 20, 9, 0, 0, 0);
		await form.initialize(existingPrompt({ type: 'once', nextRunAt: original.toISOString() }));
		form.scheduleType = 'recurring';
		const now = new Date(2030, 0, 1, 8, 0, 0, 0);

		const definition = form.buildDefinition(now);

		expect(definition?.schedule.type).toBe('recurring');
		if (definition?.schedule.type !== 'recurring') throw new Error('Expected recurring schedule');
		expect(definition.schedule.firstRunAtUtc).toBe(new Date(2030, 0, 1, 9, 0, 0, 0).toISOString());
	});

	it('preserves an unchanged recurring UTC end instant', async () => {
		const form = createForm();
		const nextRunAt = new Date(2030, 0, 2, 9, 0, 0, 0).toISOString();
		const endAt = new Date(2030, 0, 10, 10, 0, 0, 0).toISOString();
		await form.initialize(existingPrompt({ type: 'recurring', intervalDays: 2, nextRunAt, endAt }));

		const definition = form.buildDefinition(new Date(2030, 0, 1, 8, 0, 0, 0));

		expect(definition?.schedule.type).toBe('recurring');
		if (definition?.schedule.type !== 'recurring') throw new Error('Expected recurring schedule');
		expect(definition.schedule.endAtUtc).toBe(endAt);
	});

	it('hydrates and rebuilds new-chat tags when editing a scheduled prompt', async () => {
		const form = createForm();
	form.startup.selectAgent = vi.fn();
	form.startup.setPermissionMode = vi.fn();
	form.startup.setThinkingMode = vi.fn();
	form.startup.replaceAgentSettingsById = vi.fn();
		form.startup.validatePath = vi.fn();
		const scheduledPrompt: ScheduledPrompt = {
			id: 'tagged-prompt',
			schedule: { type: 'once', nextRunAt: '2030-01-02T09:00:00.000Z' },
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
				tags: ['qa', 'review-needed'],
			},
			prompt: 'Review the project',
			createdAt: '2029-01-01T00:00:00.000Z',
			updatedAt: '2029-01-01T00:00:00.000Z',
		};

		await form.initialize(scheduledPrompt);

		expect(form.startup.chatTags).toEqual(['qa', 'review-needed']);
		form.startup.settingsLoaded = true;
		form.startup.validationStatus = 'valid';
		form.startup.agentId = 'codex';
		form.prompt = scheduledPrompt.prompt;
		const definition = form.buildDefinition(new Date('2029-12-01T00:00:00.000Z'));
		expect(definition?.target).toMatchObject({
			type: 'new-chat',
			tags: ['qa', 'review-needed'],
		});
	});
});
