import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildRouterStores,
	type ConversationRouterStoreDeps,
} from '../conversation-router-adapter.svelte.ts';
import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { AgentState } from '../agent-state.svelte';
import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { TranscriptMessage } from '$shared/chat-view';
import { UserMessage } from '$shared/chat-types';
import { ConversationPanelRegistry, type ConversationPanelDescriptor } from '../conversation-panel-registry.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { DisplayBodyStore } from '$lib/chat/transcript/display-body-store.js';
import { displayOpen, mockDisplayApi } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import { CurrentConversationPanelTranscript } from '../current-conversation-panel-transcript.js';

let api: ReturnType<typeof mockDisplayApi>;
const owned: ConversationRouterStoreDeps[] = [];
afterEach(() => { for (const deps of owned.splice(0)) deps.panels.destroy(); vi.restoreAllMocks(); });

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
		bodies: new DisplayBodyStore(),
		overlays: new ConversationTranscriptOverlayStore(),
		lifecycle: {
			forChat: lifecycleForChat,
			remove: (chatId) => lifecycleByChatId.delete(chatId),
		},
		getComposerAnchorSurfaceId: () => null,
		getSelectedChatId: () => selectedChat?.id ?? null,
	});
	const deps: ConversationRouterStoreDeps = {
		sessions: {
			byId: selectedChat ? { [selectedChat.id]: selectedChat } : {},
			selectedChat,
			selectedChatId: selectedChat?.id ?? null,
			order: selectedChat ? [selectedChat.id] : [],
			patchPreview: vi.fn(),
			patchActivity: vi.fn(),
			patchChat: vi.fn(),
			patchLastReadAt: vi.fn(),
			removeChat: vi.fn(),
			setSelectedChatId: vi.fn(),
			isChatProcessing: (chatId) => chatId === selectedChat?.id && selectedChat.isProcessing,
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
	};
	owned.push(deps);
	return deps;
}

function entry(ordinal: number, content: string): TranscriptMessage {
	return {
		ordinal,
		message: new UserMessage('2026-01-01T00:00:00.000Z', content),
	};
}

function page(view: string) { return displayOpen('chat-1', view, 1); }

describe('buildRouterStores', () => {
	beforeEach(() => {
		localStorage.clear();
		api = mockDisplayApi([entry(1, 'Synthetic prompt')], page('view-1'));
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

	it('records compact background heads without hydrating unrendered history', () => {
		const deps = depsFor(chatRecord()), stores = buildRouterStores(deps);
		stores.chatState.observeHead('chat-2', 'generation-2', 2, { assistant: 2, 'command-output': 0, 'command-result': 0, thinking: 0, error: 0, permission: 0, tool: 0 });
		expect(stores.chatState.getChatCursor('chat-2')).toEqual({ transcriptViewId: 'generation-2', lastOrdinal: 2 });
		expect(api.window).not.toHaveBeenCalled();
		expect(deps.panels.bodyStore.count).toBe(0);
	});

	it('retains a selected unrendered source head without pretending it has received bodies', () => {
		const deps = depsFor(chatRecord()), stores = buildRouterStores(deps);
		deps.panels.observeHead('chat-1', 'generation-cached', 40);
		expect(stores.chatState.getChatCursor('chat-1')).toEqual({ transcriptViewId: 'generation-cached', lastOrdinal: 40 });
		expect(deps.chatState.entries).toEqual([]);
	});

	it('does not treat an acknowledgement for another chat as selected optimistic delivery', () => {
		const deps = depsFor(chatRecord()), stores = buildRouterStores(deps);
		deps.panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'input-1', content: 'Pending', createdAt: '', delivery: 'pending' });
		stores.chatState.acknowledgeInput('chat-2', 'view-2', 'input-1', 4);
		expect(deps.panels.overlayFor('chat-1')?.optimisticInputs).toHaveLength(1);
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

	it.each(['rendered', 'not-yet-rendered'])('fences fallback activation before recovering a %s replacement view', async (presentation) => {
		const deps = depsFor(chatRecord());
		deps.chatState = new CurrentConversationPanelTranscript({
			panels: deps.panels,
			getSelectedChatId: () => 'chat-1',
		});
		deps.chatState.activateChat('chat-1');
		let resolve!: (response: ReturnType<typeof page>) => void;
		api.open.mockReturnValueOnce(new Promise(done => { resolve = done; }));
		const stores = buildRouterStores(deps);
		try {
			const activation = deps.chatState.loadMessages('chat-1', { purpose: 'activation' });
			await vi.waitFor(() => expect(api.open).toHaveBeenCalledTimes(1));
			const panels: ConversationPanelDescriptor[] = [{
				surfaceId: 'chat-view:window-left', chatId: 'chat-1', presentation: 'window-left',
				windowId: 'window-left', snapshotAdmission: 'admitted',
			}];
			if (presentation === 'rendered') deps.panels.reconcile(panels);
			api.replace([entry(1, 'view-2')], page('view-2'));
			api.open.mockResolvedValueOnce(page('view-2'));
			if (presentation === 'rendered') {
				stores.chatState.markRenderedChatStale('chat-1');
			} else {
				stores.chatState.markChatTranscriptStale('chat-1');
				deps.panels.reconcile(panels);
			}
			await stores.chatState.loadRenderedChat('chat-1');
			const panel = deps.panels.panel('chat-view:window-left')!;
			expect(panel.transcript.transcriptViewId).toBe('view-2');
			resolve(page('view-1'));
			await activation;
			expect(panel.transcript.transcriptViewId).toBe('view-2');
			expect(panel.transcript.entries).toEqual([entry(1, 'view-2')]);
		} finally {
			deps.panels.destroy();
		}
	});

	it('clears rejected optimistic input after replacement while its panel is unmounted', async () => {
		const deps = depsFor(chatRecord());
		deps.chatState = new CurrentConversationPanelTranscript({
			panels: deps.panels,
			getSelectedChatId: () => deps.sessions.selectedChatId,
		});
		const panels: ConversationPanelDescriptor[] = [{
			surfaceId: 'chat-view:window-left', chatId: 'chat-1', presentation: 'window-left',
			windowId: 'window-left', snapshotAdmission: 'admitted',
		}];
		const stores = buildRouterStores(deps);
		try {
			deps.panels.reconcile(panels);
			deps.chatState.upsertOptimisticUserInput({
				chatId: 'chat-1', clientMessageId: 'input-1', content: 'pending input',
				createdAt: '2026-01-01T00:00:00.000Z', delivery: 'pending',
			});
			expect(deps.panels.overlayFor('chat-1')?.optimisticInputs).toHaveLength(1);
			deps.panels.reconcile([]);
			deps.chatState.activateChat(null);
			stores.chatState.markChatTranscriptStale('chat-1');
			deps.chatState.clearOptimisticUserInput('input-1');
			api.replace([entry(1, 'view-2')], page('view-2'));
			api.open.mockResolvedValueOnce(page('view-2'));
			deps.panels.reconcile(panels);
			await stores.chatState.loadRenderedChat('chat-1');
			const panel = deps.panels.panel('chat-view:window-left')!;
			expect(panel.transcript.transcriptViewId).toBe('view-2');
			expect(panel.transcript.visibleOptimisticInputs).toHaveLength(0);
			expect(deps.panels.overlayFor('chat-1')?.optimisticInputs).toHaveLength(0);
		} finally {
			deps.panels.destroy();
		}
	});

	it('maps remote chat deletion to workspace presentation cleanup', () => {
		const deps = depsFor(chatRecord());
		const stores = buildRouterStores(deps);

		stores.chatPresentations.clearDeletedChat('chat-1');

		expect(deps.clearDeletedChat).toHaveBeenCalledWith('chat-1');
	});
});
