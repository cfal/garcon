import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildRouterStores,
	type ConversationRouterDeps,
} from '../conversation-router-adapter.svelte';
import { ChatState } from '../state.svelte';
import { AgentState } from '../agent-state.svelte';
import { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
import { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
import { StartupCoordinator } from '../startup-coordinator';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatViewMessage } from '$shared/chat-view';
import { UserMessage } from '$shared/chat-types';
import type { BackgroundTranscriptLoader } from '../background-transcript-loader';

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

function entry(seq: number, content: string): ChatViewMessage {
	return {
		seq,
		message: new UserMessage('2026-01-01T00:00:00.000Z', content),
	};
}

describe('buildRouterStores', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('returns the selected chat record directly for router consumers', () => {
		const selectedChat = chatRecord();
		const stores = buildRouterStores(depsFor(selectedChat));

		expect(stores.sessions.selectedChat()).toBe(selectedChat);
	});

	it('warms background transcripts through the shared transcript cache', () => {
		const deps = depsFor(chatRecord());
		deps.chatState.transcriptCache.replace('chat-2', 'generation-2', [entry(1, 'one')], 1);
		const stores = buildRouterStores(deps);

		const applied = stores.chatState.warmBackgroundTranscript('chat-2', 'generation-2', [
			entry(2, 'two'),
		]);

		expect(applied).toBe(true);
		expect(deps.chatState.transcriptCache.get('chat-2')?.messages.map((item) => item.seq)).toEqual([
			1, 2,
		]);
	});

	it('does not create tail-only background transcripts and queues recovery', () => {
		const deps = depsFor(chatRecord());
		const queueLoad = vi.fn();
		deps.backgroundTranscriptLoader = { queueLoad } as unknown as BackgroundTranscriptLoader;
		const stores = buildRouterStores(deps);

		const applied = stores.chatState.warmBackgroundTranscript('chat-2', 'generation-2', [
			entry(4, 'tail'),
		]);

		expect(applied).toBe(false);
		expect(deps.chatState.transcriptCache.get('chat-2')).toBeNull();
		expect(queueLoad).toHaveBeenCalledWith('chat-2', {
			generationId: 'generation-2',
			messages: [expect.objectContaining({ seq: 4 })],
		});
	});

	it('maps visible preview callbacks into router chat state hooks', () => {
		const deps = depsFor(chatRecord());
		deps.visiblePreviews = {
			isVisible: vi.fn((chatId) => chatId === 'chat-2'),
			applyMessages: vi.fn(() => true),
			loadSnapshot: vi.fn(),
			markStale: vi.fn(),
		};
		const stores = buildRouterStores(deps);

		expect(stores.chatState.isVisiblePreviewChat('chat-2')).toBe(true);
		expect(
			stores.chatState.warmVisibleChatPreview('chat-2', 'generation-2', [entry(2, 'two')]),
		).toBe(true);
		stores.chatState.markVisibleChatPreviewStale('chat-2');
		void stores.chatState.loadVisibleChatPreview('chat-2');

		expect(deps.visiblePreviews.applyMessages).toHaveBeenCalledWith(
			'chat-2',
			'generation-2',
			expect.arrayContaining([expect.objectContaining({ seq: 2 })]),
		);
		expect(deps.visiblePreviews.markStale).toHaveBeenCalledWith('chat-2');
		expect(deps.visiblePreviews.loadSnapshot).toHaveBeenCalledWith('chat-2');
	});

	it('passes preview timestamps through to the sessions store', () => {
		const deps = depsFor(chatRecord());
		const stores = buildRouterStores(deps);

		stores.sessions.patchChatPreview('chat-1', 'Preview', '2026-02-25T12:00:00.000Z');

		expect(deps.sessions.patchPreview).toHaveBeenCalledWith(
			'chat-1',
			'Preview',
			'2026-02-25T12:00:00.000Z',
		);
	});
});
