import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { NewChatScheduledPromptTarget, ScheduledPrompt } from '$shared/scheduled-prompts';

export function scheduledNewChat(): ScheduledPrompt & { target: NewChatScheduledPromptTarget } {
	return {
		id: 'task-a', enabled: false, name: 'Synthetic review',
		prompt: '  Review {{chat_id}} on {{current_date}}\n',
		schedule: { type: 'once', nextRunAt: '2099-01-01T00:00:00.000Z' },
		createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
		target: {
			type: 'new-chat', executorId: '00000000-0000-4000-8000-000000000001',
			agentId: 'codex', projectPath: '/worker/project', model: 'synthetic-model',
			apiProviderId: 'provider-a', modelEndpointId: 'endpoint-a', modelProtocol: 'openai-compatible',
			permissionMode: 'acceptEdits', thinkingMode: 'high',
			agentSettingsById: { codex: { ownerId: 'codex', schemaVersion: 1, values: { nested: { value: 'saved' } } } },
			tags: ['review'], preambleChoice: { mode: 'explicit', orderedPreambleIds: ['preamble-a'] },
			chatTitleTemplate: 'Scheduled title {{current_date}}',
		},
	};
}

export function sourceChat(): ChatSessionRecord {
	return {
		id: '1000000000000001', executorId: '00000000-0000-4000-8000-000000000001',
		parentChat: null, projectPath: '/worker/current', orderGroup: 'normal', title: 'Synthetic source',
		agentId: 'codex', model: 'current-model', permissionMode: 'default', thinkingMode: 'none',
		agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
		createdAt: null, lastActivityAt: null, lastReadAt: null, isPinned: false, isArchived: false,
		isProcessing: false, processingPhase: null, activityStatus: null, canReloadFromNativeHistory: false,
		isUnread: false, status: 'running', agentOwnershipEpoch: 'epoch-a', tags: ['source'],
	};
}
