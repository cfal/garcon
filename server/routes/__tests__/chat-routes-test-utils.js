import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { CommandLedger } from '../../commands/command-ledger.js';
import { ChatCommandService } from '../../commands/chat-command-service.js';
import { forkChatFileCopy } from '../../chats/fork-chat.js';
import { ChatIdAllocator } from '../../chats/chat-id-allocator.js';
import { ChatListProjector } from '../../chats/chat-list-projector.js';
import { mock } from 'bun:test';

export function createRouteCommandLedger(label = 'chat-routes') {
  return new CommandLedger(path.join(os.tmpdir(), `garcon-${label}-ledger-${randomUUID()}`));
}

export function createRoutePendingInputs() {
  return {
    register: () => Promise.resolve(undefined),
    reconcile: () => Promise.resolve(undefined),
    listForChat: () => [],
    clearChat: () => undefined,
    discardChat: () => 0,
    discard: () => false,
  };
}

export function createRouteChatViews() {
  return {
    getOrCreatePage: () => Promise.resolve({
      messages: [],
      generationId: 'generation-1',
      lastSeq: 0,
      pageOldestSeq: 0,
      hasMore: false,
    }),
  };
}

export function createRoutePathCache() {
  return {
    resolveProjectPath: mock(async (projectPath) => ({
      available: true,
      effectiveProjectKey: projectPath,
    })),
    resolveProjectPaths: mock(async (projectPaths) => new Map(
      [...new Set(projectPaths)].map((projectPath) => [projectPath, {
        available: true,
        effectiveProjectKey: projectPath,
      }]),
    )),
  };
}

export function createRouteChatListProjector({ registry, settings, metadata, agents, pathCache }) {
  return new ChatListProjector({ registry, settings, metadata, agents, pathCache });
}

export function createRouteCommandService({
  registry,
  queue,
  settings,
  metadata,
  agents,
  commandLedger,
  pendingInputs,
	pathCache,
	chatListProjector,
  forkChatFileCopy: forkChatFileCopyOverride,
}) {
  return new ChatCommandService({
    chats: registry,
    queue,
    settings,
    metadata,
    agents,
    ledger: commandLedger,
    pendingInputs,
    chatIds: new ChatIdAllocator(registry),
	pathCache: pathCache ?? createRoutePathCache(),
	chatListProjector: chatListProjector ?? {
		buildOne: async (chatId) => {
			const session = registry.getChat(chatId);
			if (!session) return null;
			return {
				id: chatId,
				agentId: session.agentId,
				model: session.model ?? null,
				permissionMode: session.permissionMode ?? 'default',
				thinkingMode: session.thinkingMode ?? 'none',
				claudeThinkingMode: session.claudeThinkingMode ?? 'auto',
				ampAgentMode: session.ampAgentMode ?? 'smart',
				title: 'Chat',
				projectPath: session.projectPath,
				effectiveProjectKey: session.projectPath,
				orderGroup: 'normal',
				tags: session.tags ?? [],
				activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
				preview: { lastMessage: '' },
				isPinned: false,
				isArchived: false,
				isActive: false,
				isUnread: false,
			};
		},
	},
    forkChatFileCopy: forkChatFileCopyOverride ?? forkChatFileCopy,
  });
}
