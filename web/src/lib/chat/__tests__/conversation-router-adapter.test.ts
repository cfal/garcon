import { describe, expect, it, vi } from 'vitest';
import { buildRouterStores, type ConversationRouterDeps } from '../conversation-router-adapter.svelte';
import { ChatState } from '../state.svelte';
import { AgentState } from '../agent-state.svelte';
import { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
import { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
import { StartupCoordinator } from '../startup-coordinator';
import type { ChatSessionRecord } from '$lib/types/chat-session';

vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
}));

function chatRecord(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/repo',
		title: 'Chat 1',
		agentId: 'claude',
		model: 'opus',
		permissionMode: 'default',
		thinkingMode: 'none',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'running',
		tags: [],
		...overrides,
	};
}

function depsFor(selectedChat: ChatSessionRecord | null): ConversationRouterDeps {
	return {
		ws: {} as never,
		drainHandle: {} as never,
		sessions: {
			selectedChat,
			selectedChatId: selectedChat?.id ?? null,
			byId: selectedChat ? { [selectedChat.id]: selectedChat } : {},
			order: selectedChat ? [selectedChat.id] : [],
			hasChat: (chatId) => chatId === selectedChat?.id,
			patchPreview: vi.fn(),
			patchChat: vi.fn(),
			patchLastReadAt: vi.fn(),
			removeChat: vi.fn(),
			setSelectedChatId: vi.fn(),
			setChatProcessing: vi.fn(),
			reconcileProcessing: vi.fn(),
			quietRefreshChats: vi.fn(),
		},
		chatState: new ChatState(),
		agentState: new AgentState(),
		lifecycle: new ChatLifecycleStore(),
		conversationUi: new ConversationUiStore(),
		startupCoordinator: new StartupCoordinator(),
		readReceiptOutbox: { enqueue: vi.fn() },
	};
}

describe('buildRouterStores', () => {
	it('returns the selected chat record directly for router consumers', () => {
		const selectedChat = chatRecord();
		const stores = buildRouterStores(depsFor(selectedChat));

		expect(stores.sessions.selectedChat()).toBe(selectedChat);
	});
});
