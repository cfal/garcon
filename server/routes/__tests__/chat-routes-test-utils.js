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
  const processing = {
    phase(chatId) {
      const session = registry.getChat(chatId);
      return session && agents.isAgentSessionRunning(session.agentId, session.agentSessionId)
        ? 'running'
        : null;
    },
  };
  return new ChatListProjector({
    registry,
    settings,
    metadata,
    processing,
    pathCache,
    canReloadFromNativeHistory: () => false,
  });
}

export function createRouteCommandService({
  registry,
  queue,
  settings,
  metadata,
  agents,
  commandLedger,
	handoffs,
	pathCache,
	chatListProjector,
  forkChatFileCopy: forkChatFileCopyOverride,
  ownership,
  transientFeeds,
}) {
  const transcripts = {
    currentView: () => null,
    highWatermark: () => ({ viewId: 'view-1', ordinal: 0 }),
    rowsThrough: () => [],
    initializeChat: () => ({ viewId: 'view-2' }),
    deleteChat: () => undefined,
  };
  return new ChatCommandService({
    chats: registry,
    queue,
    transcripts,
    settings,
    recentTitleIcons: {
      getRecentIcons: () => [],
    },
    metadata,
    agents,
    ledger: commandLedger,
    transientFeeds: transientFeeds ?? { validateAction: () => undefined },
	handoffs: handoffs ?? {
		resolveTarget: async ({ handoff }) => ({
			agentId: handoff.target.agentId,
			model: handoff.target.model,
			apiProviderId: handoff.target.apiProviderId ?? null,
			modelEndpointId: handoff.target.modelEndpointId ?? null,
			modelProtocol: handoff.target.modelProtocol ?? null,
			permissionMode: handoff.target.permissionMode ?? 'default',
			thinkingMode: handoff.target.thinkingMode ?? 'none',
			agentSettings: handoff.target.agentSettings ?? {
				ownerId: handoff.target.agentId,
				schemaVersion: 1,
				values: {},
			},
		}),
		createPreparation: () => ({
			prepare: async () => undefined,
			compensate: async () => undefined,
		}),
		seedContinuationLedger: ({ sourceChatId, targetChatId }) => {
			const watermark = transcripts.highWatermark(sourceChatId);
			transcripts.initializeChat(targetChatId, [], 1);
			return watermark;
		},
		deleteContinuationLedger: (chatId) => transcripts.deleteChat(chatId),
	},
    fileMentions: { resolve: async (command) => command },
    ownership: ownership ?? {
      delete: async (chatId) => {
        if (!registry.getChat(chatId)) return false;
        registry.removeChat(chatId);
        return true;
      },
    },
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
				agentSettings: session.agentSettingsById?.[session.agentId] ?? {
					ownerId: session.agentId,
					schemaVersion: 1,
					values: {},
				},
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
    transcripts,
  });
}
