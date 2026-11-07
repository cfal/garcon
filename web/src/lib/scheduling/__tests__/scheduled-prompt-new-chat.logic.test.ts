import { describe, expect, it } from 'vitest';
import { scheduledPromptStartup } from '../scheduled-prompt-new-chat';
import { scheduledNewChat, sourceChat } from './scheduled-prompt-new-chat-fixture';

describe('scheduled prompt startup copy', () => {
	it('copies the complete saved target without aliases or schedule-only metadata', () => {
		const task = scheduledNewChat();
		const original = structuredClone(task);
		const seed = scheduledPromptStartup(task, undefined, undefined)!;
		expect(seed).toMatchObject({ executorId: task.target.executorId, model: 'synthetic-model',
			apiProviderId: 'provider-a', modelEndpointId: 'endpoint-a', modelProtocol: 'openai-compatible',
			permissionMode: 'acceptEdits', thinkingMode: 'high', tags: ['review'],
			preambleChoice: { mode: 'explicit', orderedPreambleIds: ['preamble-a'] } });
		expect(seed).not.toHaveProperty('chatTitleTemplate');
		expect(seed).not.toHaveProperty('name');
		expect(seed.agentSettingsById.codex.values.nested).not.toBe(task.target.agentSettingsById.codex.values.nested);
		expect(seed.tags).not.toBe(task.target.tags);
		if (seed.preambleChoice.mode === 'explicit' && task.target.preambleChoice.mode === 'explicit') {
			expect(seed.preambleChoice.orderedPreambleIds).not.toBe(task.target.preambleChoice.orderedPreambleIds);
		}
		expect(task).toEqual(original);
	});

	it('copies current existing-chat settings with default new-chat preambles', () => {
		const chat = sourceChat();
		const task = { ...scheduledNewChat(), target: { type: 'existing-chat' as const, chatId: chat.id, busyBehavior: 'queue' as const } };
		expect(scheduledPromptStartup(task, chat, 'conversation')).toEqual({
			executorId: chat.executorId, agentId: chat.agentId, model: chat.model,
			projectPath: chat.projectPath, apiProviderId: null, modelEndpointId: null, modelProtocol: null,
			permissionMode: chat.permissionMode, thinkingMode: chat.thinkingMode,
			agentSettingsById: { codex: chat.agentSettings }, tags: chat.tags, preambleChoice: { mode: 'defaults' },
		});
	});

	it('rejects missing, incomplete, unguarded literal, and stale guarded targets', () => {
		const chat = sourceChat();
		const task = { ...scheduledNewChat(), target: { type: 'existing-chat' as const, chatId: chat.id, busyBehavior: 'queue' as const } };
		for (const invalid of [undefined, { ...chat, model: null }, { ...chat, model: '' }, { ...chat, projectPath: ' ' }, { ...chat, status: 'draft' as const }]) {
			expect(scheduledPromptStartup(task, invalid, 'conversation')).toBeNull();
		}
		for (const policy of ['literal', undefined] as const) expect(scheduledPromptStartup(task, chat, policy)).toBeNull();
		const guarded = { ...task, target: { ...task.target, expectedSelection: {
			agentId: chat.agentId, agentOwnershipEpoch: chat.agentOwnershipEpoch, model: chat.model,
		} } };
		expect(scheduledPromptStartup(guarded, chat, 'literal')).not.toBeNull();
		for (const changed of [{ ...chat, agentId: 'shell' }, { ...chat, model: 'shell' }, { ...chat, agentOwnershipEpoch: 'epoch-b' }]) {
			expect(scheduledPromptStartup(guarded, changed, 'literal')).toBeNull();
		}
	});
});
