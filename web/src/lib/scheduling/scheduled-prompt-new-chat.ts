import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { NewChatStartupSeed } from '$lib/chat/new-chat/new-chat-seed';
import { cloneAgentSettings } from '$shared/agent-settings';
import { effectiveExecutorId } from '$shared/executors';
import { scheduledPromptSelectionMatches, type ScheduledPrompt } from '$shared/scheduled-prompts';

export function canOpenScheduledPromptInNewChat(
	prompt: ScheduledPrompt,
	chat: ChatSessionRecord | undefined,
	executionPolicy: 'conversation' | 'literal' | undefined,
): boolean {
	if (prompt.target.type === 'new-chat') return true;
	if (!chat || chat.status === 'draft' || !chat.model || !chat.projectPath.trim()) return false;
	return prompt.target.expectedSelection
		? scheduledPromptSelectionMatches(prompt.target.expectedSelection, chat)
		: executionPolicy === 'conversation';
}

export function scheduledPromptStartup(
	prompt: ScheduledPrompt,
	chat: ChatSessionRecord | undefined,
	executionPolicy: 'conversation' | 'literal' | undefined,
): NewChatStartupSeed | null {
	if (!canOpenScheduledPromptInNewChat(prompt, chat, executionPolicy)) return null;
	const target = prompt.target.type === 'new-chat' ? prompt.target : chat!;
	const settings = prompt.target.type === 'new-chat'
		? prompt.target.agentSettingsById : { [chat!.agentId]: chat!.agentSettings };
	const preambles = prompt.target.type === 'new-chat'
		? prompt.target.preambleChoice : { mode: 'defaults' as const };
	return {
		executorId: effectiveExecutorId(target.executorId),
		agentId: target.agentId,
		projectPath: target.projectPath,
		model: target.model!,
		apiProviderId: target.apiProviderId ?? null,
		modelEndpointId: target.modelEndpointId ?? null,
		modelProtocol: target.modelProtocol ?? null,
		permissionMode: target.permissionMode,
		thinkingMode: target.thinkingMode,
		agentSettingsById: Object.fromEntries(Object.entries(settings).map(([id, value]) => [id, cloneAgentSettings(value)])),
		tags: [...target.tags],
		preambleChoice: preambles.mode === 'defaults'
			? { mode: 'defaults' } : { mode: 'explicit', orderedPreambleIds: [...preambles.orderedPreambleIds] },
	};
}
