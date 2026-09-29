import { describe, expect, it } from 'vitest';
import type { ScheduledPrompt, ScheduledPromptTarget } from '$shared/scheduled-prompts';
import { scheduledPromptExecutorId } from '../scheduled-prompt-executor.js';

const workerId = '22222222-2222-4222-8222-222222222222';

function prompt(target: ScheduledPromptTarget): ScheduledPrompt {
	return {
		id: 'prompt-1',
		schedule: { type: 'once', nextRunAt: '2030-01-01T00:00:00.000Z' },
		target,
		prompt: 'Synthetic prompt',
		createdAt: '2030-01-01T00:00:00.000Z',
		updatedAt: '2030-01-01T00:00:00.000Z',
	};
}

function newChatTarget(executorId?: string | null): ScheduledPromptTarget {
	return {
		type: 'new-chat',
		...(executorId === undefined ? {} : { executorId }),
		agentId: 'claude',
		projectPath: '/workspace/project',
		model: 'opus',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettingsById: {},
		tags: [],
		preambleChoice: { mode: 'defaults' },
	};
}

describe('scheduledPromptExecutorId', () => {
	it('uses the executor a new chat will start on', () => {
		expect(scheduledPromptExecutorId(prompt(newChatTarget()), undefined)).toBe('local');
		expect(scheduledPromptExecutorId(prompt(newChatTarget(null)), undefined)).toBe('local');
		expect(scheduledPromptExecutorId(prompt(newChatTarget(workerId)), undefined)).toBe(workerId);
	});

	it('follows an existing chat to its current executor and leaves a missing chat unknown', () => {
		const target: ScheduledPromptTarget = { type: 'existing-chat', chatId: 'chat-1', busyBehavior: 'queue' };
		expect(scheduledPromptExecutorId(prompt(target), { executorId: workerId })).toBe(workerId);
		expect(scheduledPromptExecutorId(prompt(target), { executorId: null })).toBe('local');
		expect(scheduledPromptExecutorId(prompt(target), {})).toBe('local');
		expect(scheduledPromptExecutorId(prompt(target), undefined)).toBeNull();
	});
});
