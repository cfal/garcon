import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildRouterStores,
	type ConversationRouterStoreDeps,
} from '../conversation-router-adapter.svelte';
import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { AgentState } from '../agent-state.svelte';
import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { TranscriptMessage } from '$shared/chat-view';
import { UserMessage } from '$shared/chat-types';
import { ConversationPanelRegistry } from '../conversation-panel-registry.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';

vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
}));

function chatRecord(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/repo',
		orderGroup: 'normal',
		title: 'Chat 1',
		agentId: 'claude',
		model: 'opus',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'running',
		tags: [],
		...overrides,
		parentChat: overrides.parentChat ?? null,
		agentOwnershipEpoch: overrides.agentOwnershipEpoch ?? null,
	};
}

function depsFor(selectedChat: ChatSessionRecord | null): ConversationRouterStoreDeps {
	const lifecycle = new ConversationLifecycleState();
	const lifecycleByChatId = new Map<string, ConversationLifecycleState>();
	if (selectedChat) {
		lifecycle.setCurrentChatId(selectedChat.id);
		lifecycleByChatId.set(selectedChat.id, lifecycle);
	}
	const lifecycleForChat = (chatId: string) => {
		const existing = lifecycleByChatId.get(chatId);
		if (existing) return existing;
		const created = new ConversationLifecycleState();
		created.setCurrentChatId(chatId);
		lifecycleByChatId.set(chatId, created);
		return created;
	};
	const chatState = Object.assign(new ActiveTranscriptState(), {
		discardChat: vi.fn(),
	});
	const panels = new ConversationPanelRegistry({
		cache: chatState.transcriptCache,
		overlays: new ConversationTranscriptOverlayStore(),
		lifecycle: {
			forChat: lifecycleForChat,
			remove: (chatId) => lifecycleByChatId.delete(chatId),
		},
		getComposerAnchorSurfaceId: () => null,
		getSelectedChatId: () => selectedChat?.id ?? null,
	});
	return {
		sessions: {
			byId: selectedChat ? { [selectedChat.id]: selectedChat } : {},
			selectedChat,
			selectedChatId: selectedChat?.id ?? null,
			order: selectedChat ? [selectedChat.id] : [],
			hasChat: (chatId) => chatId === selectedChat?.id,
			patchPreview: vi.fn(),
			patchActivity: vi.fn(),
			patchChat: vi.fn(),
			patchLastReadAt: vi.fn(),
			removeChat: vi.fn(),
			setSelectedChatId: vi.fn(),
			isChatProcessing: (chatId) => chatId === selectedChat?.id && selectedChat.isProcessing,
			applyProcessingEvent: vi.fn(),
			reconcileProcessing: vi.fn(),
			quietRefreshChats: vi.fn(),
		},
		chatState,
		agentState: new AgentState(),
		lifecycle,
		lifecycles: {
			forChat: lifecycleForChat,
			get: (chatId) => lifecycleByChatId.get(chatId) ?? null,
		},
		conversationUi: new ConversationUiState(),
		startupCoordinator: new StartupCoordinator(),
		readReceiptOutbox: { enqueue: vi.fn() },
		notifyCompletion: vi.fn(),
		panels,
		clearDeletedChat: vi.fn(),
		projectResolution: {
			invalidateChat: vi.fn(),
			seed: vi.fn(),
		},
	};
}

function entry(ordinal: number, content: string): TranscriptMessage {
	return {
		ordinal,
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

		expect(stores.sessions.selectedChat).toBe(selectedChat);
	});

	it('updates background plan mode without mutating selected composer settings', () => {
		const deps = depsFor(chatRecord());
		deps.sessions.byId['chat-2'] = chatRecord({ id: 'chat-2', permissionMode: 'acceptEdits' });
		deps.agentState.permissionMode = 'default';
		const stores = buildRouterStores(deps);

		expect(stores.agentSettings.permissionMode('chat-2')).toBe('acceptEdits');
		stores.agentSettings.setPermissionMode('chat-2', 'plan');

		expect(deps.sessions.patchChat).toHaveBeenCalledWith('chat-2', { permissionMode: 'plan' });
		expect(deps.agentState.permissionMode).toBe('default');
	});

	it('routes loading status entries to the addressed chat lifecycle', () => {
		const deps = depsFor(chatRecord());
		const stores = buildRouterStores(deps);

		stores.lifecycle.pushLoadingStatus('chat-2', {
			id: 'permission',
			text: 'Waiting',
			tokens: 0,
			can_interrupt: true,
		});

		expect(deps.lifecycles.get('chat-2')?.loadingStatus?.text).toBe('Waiting');
		expect(deps.lifecycles.get('chat-1')?.loadingStatus).toBeNull();
	});

	it('applies background transcripts through the shared transcript cache', () => {
		const deps = depsFor(chatRecord());
		deps.chatState.transcriptCache.replace('chat-2', 'generation-2', [entry(1, 'one')], 1, null);
		const stores = buildRouterStores(deps);

		const applied = stores.chatState.applyChatMessages(
			'chat-2',
			'generation-2',
			[entry(2, 'two')],
			2,
			2,
			[],
		);

		expect(applied).toBe('applied');
		expect(
			deps.chatState.transcriptCache.get('chat-2')?.messages.map((item) => item.ordinal),
		).toEqual([1, 2]);
		deps.panels.destroy();
		deps.chatState.transcriptCache.flush();
	});

	it('reads a selected but unrendered chat cursor from the shared panel cache', () => {
		const deps = depsFor(chatRecord());
		deps.chatState.transcriptCache.replace(
			'chat-1',
			'generation-cached',
			[entry(1, 'cached')],
			1,
			null,
		);
		const stores = buildRouterStores(deps);

		expect(stores.chatState.getChatCursor('chat-1')).toMatchObject({
			transcriptViewId: 'generation-cached',
			lastOrdinal: 1,
		});
		deps.panels.destroy();
		deps.chatState.transcriptCache.flush();
	});

	it('does not create tail-only background transcripts before a rendered-panel recovery', () => {
		const deps = depsFor(chatRecord());
		const stores = buildRouterStores(deps);

		const applied = stores.chatState.applyChatMessages(
			'chat-2',
			'generation-2',
			[entry(4, 'tail')],
			4,
			4,
			[],
		);

		expect(applied).toBe('gap-detected');
		expect(deps.chatState.transcriptCache.get('chat-2')).toBeNull();
		deps.panels.destroy();
		deps.chatState.transcriptCache.flush();
	});

	it('passes preview timestamps through to the sessions store', () => {
		const deps = depsFor(chatRecord());
		const stores = buildRouterStores(deps);

		stores.sessions.patchPreview('chat-1', 'Preview', '2026-02-25T12:00:00.000Z');

		expect(deps.sessions.patchPreview).toHaveBeenCalledWith(
			'chat-1',
			'Preview',
			'2026-02-25T12:00:00.000Z',
		);
	});

	it('discards the shared draft when the server deletes a chat', () => {
		const deps = depsFor(chatRecord());
		const discardChat = vi.fn();
		deps.chatDrafts = { discardChat };
		const stores = buildRouterStores(deps);

		stores.chatState.removeChatTranscript('chat-1');

		expect(deps.chatState.discardChat).toHaveBeenCalledWith('chat-1');
		expect(discardChat).toHaveBeenCalledWith('chat-1');
	});

	it('maps remote chat deletion to workspace presentation cleanup', () => {
		const deps = depsFor(chatRecord());
		const stores = buildRouterStores(deps);

		stores.chatPresentations.clearDeletedChat('chat-1');

		expect(deps.clearDeletedChat).toHaveBeenCalledWith('chat-1');
	});
});
