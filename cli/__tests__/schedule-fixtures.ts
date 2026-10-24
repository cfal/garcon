import type { ScheduledPrompt, ScheduledPromptDefinitionInput, ScheduledPromptsSnapshot } from '@garcon/common/scheduled-prompts';

export const scheduleId = '11111111-1111-4111-8111-111111111111';
export const scheduleChatId = '1000000000000001';
export const scheduleDefinition: ScheduledPromptDefinitionInput = {
  name: 'Synthetic task',
  schedule: { type: 'once', runAtUtc: '2099-01-01T09:00:00.000Z' },
  target: { type: 'existing-chat', chatId: scheduleChatId, busyBehavior: 'skip' },
  prompt: 'Synthetic scheduled input',
};
export const schedulePrompt: ScheduledPrompt = {
  id: scheduleId, enabled: true, name: scheduleDefinition.name,
  schedule: { type: 'once', nextRunAt: '2099-01-01T09:00:00.000Z' },
  target: scheduleDefinition.target, prompt: scheduleDefinition.prompt,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
export const scheduleSnapshot: ScheduledPromptsSnapshot = { revision: 1, prompts: [schedulePrompt], runLog: [] };
export const newChatDefinition: ScheduledPromptDefinitionInput = {
  ...scheduleDefinition,
  target: { type: 'new-chat', executorId: 'local', agentId: 'codex', projectPath: '/synthetic/project',
    model: 'synthetic-model', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
    permissionMode: 'default', thinkingMode: 'none', agentSettingsById: {}, tags: [], preambleChoice: { mode: 'defaults' } },
};
