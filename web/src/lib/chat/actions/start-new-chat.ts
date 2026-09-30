import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { NewChatConfig } from '$lib/types/app.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
import type { ChatId } from '$shared/chat-id';
import { gotoChat } from './chat-navigation.js';

export interface StartNewChatPorts {
	readonly sessions: Pick<ChatSessionsStore, 'createDraft'>;
	readonly workspace: Pick<WorkspaceCoordinator, 'focusChat'>;
	readonly appShell: Pick<AppShellStore, 'requestComposerFocus'>;
	readonly navigate?: (chatId: string) => Promise<void>;
}

/**
 * Opens a draft chat and focuses it. The conversation submits the configured
 * first message automatically when the draft activates.
 */
export function startNewChat(ports: StartNewChatPorts, chatId: ChatId, config: NewChatConfig): void {
	ports.sessions.createDraft({
		id: chatId,
		projectPath: config.projectPath,
		startup: {
			executorId: config.executorId,
			agentId: config.agentId,
			model: config.model,
			apiProviderId: config.apiProviderId ?? null,
			modelEndpointId: config.modelEndpointId ?? null,
			modelProtocol: config.modelProtocol ?? null,
			permissionMode: config.permissionMode,
			thinkingMode: config.thinkingMode,
			agentSettings: config.agentSettings,
			firstMessage: config.firstMessage,
			initialImages: config.initialImages,
			tags: config.tags,
			orderedPreambleIds: config.orderedPreambleIds,
		},
	});
	void ports.workspace.focusChat();
	void (ports.navigate ?? gotoChat)(chatId).finally(() => ports.appShell.requestComposerFocus());
}
