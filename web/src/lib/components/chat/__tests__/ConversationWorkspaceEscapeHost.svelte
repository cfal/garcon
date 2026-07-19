<script lang="ts">
	import ConversationWorkspace from '../ConversationWorkspace.svelte';
	import {
		setAppShell,
		setChatSessions,
		setLocalSettings,
		setModelCatalog,
		setReadReceiptOutbox,
		setRemoteSettings,
		setWs,
		setWorkspaceCoordinator,
		setWorkspaceShortcuts,
		setTransientLayers,
		setGitQuickSummary,
		setGitBranchActions,
	} from '$lib/context';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { DrainCursor } from '$lib/ws/connection.svelte';
	import KeyboardShortcuts from '$lib/components/shared/KeyboardShortcuts.svelte';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import { WorkspaceShortcutDispatcher } from '$lib/workspace/workspace-shortcuts';
	import { GitQuickSummaryStore } from '$lib/git/surface/git-quick-summary.svelte.js';
	import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';

	const selectedChat: ChatSessionRecord = {
		id: 'chat-1',
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Running chat',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: '2026-01-01T00:00:00.000Z',
		lastActivityAt: '2026-01-01T00:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: true,
		isUnread: false,
		status: 'running',
		tags: [],
	};

	const sessions = {
		get selectedChatId() {
			return selectedChat.id;
		},
		get selectedChat() {
			return selectedChat;
		},
		get byId() {
			return { [selectedChat.id]: selectedChat };
		},
		get orderedChats() {
			return [selectedChat];
		},
		get order() {
			return [selectedChat.id];
		},
		startupByChatId: {},
		hasChat: (chatId: string) => chatId === selectedChat.id,
		isDraft: () => false,
		patchDraftStartup: () => {},
		patchPreview: () => {},
		patchChat: () => {},
		patchLastReadAt: () => {},
		applyStartEntry: () => {},
		upsertServerChat: () => {},
		removeChat: () => {},
		setSelectedChatId: () => {},
		applyProcessingEvent: () => {},
		reconcileProcessing: () => {},
		invalidateProcessingAuthority: () => {},
		quietRefreshChats: () => Promise.resolve(),
	};

	setChatSessions(sessions as never);
	setLocalSettings({
		autoScrollToBottom: true,
		showQuickCommitTray: false,
		chatMaxWidth: 'default',
	} as never);
	setAppShell({
		isMobile: false,
		requestComposerFocus: () => {},
		openNewChatDialog: () => {},
	} as never);
	setWs({
		messages: [],
		trimOffset: 0,
		isConnected: false,
		registerCursor: (_cursor: DrainCursor) => () => {},
		sendRequest: () => Promise.resolve({}),
	} as never);
	setReadReceiptOutbox({
		enqueue: () => {},
	} as never);
	setRemoteSettings({} as never);
	setModelCatalog({
		selectionValueFor: (_agentId: string, model: string) => model,
		selectionFor: (_agentId: string, model: string) => ({
			model,
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		}),
		isLocalModel: () => false,
		supportsFork: () => true,
		supportsForkWhileRunning: () => true,
	} as never);

	const chatInteractionGate = new ChatInteractionGate();
	const transientLayers = new TransientLayerRegistry(chatInteractionGate);
	const workspace = {
		focusOwner: { kind: 'surface', surfaceId: 'singleton:chat' },
		isSurfacePresented: () => true,
		layout: {
			surface: (surfaceId: string) =>
				surfaceId === 'singleton:chat'
					? { id: 'singleton:chat', type: 'singleton', kind: 'chat' }
					: null,
		},
		focusChat: () => Promise.resolve(),
		focusMobileSingleton: () => Promise.resolve(),
		openSingleton: () => Promise.resolve(),
	} as never;
	const workspaceShortcuts = new WorkspaceShortcutDispatcher({
		workspace,
		transients: transientLayers,
		appShell: {} as never,
		navigation: {} as never,
		files: {} as never,
	});
	setWorkspaceCoordinator(workspace);
	setWorkspaceShortcuts(workspaceShortcuts);
	setTransientLayers(transientLayers);
	setGitQuickSummary(new GitQuickSummaryStore());
	setGitBranchActions(new GitBranchSelectorState());

	let showTestLayer = $state(false);
	let testLayerElement = $state<HTMLElement | null>(null);
	$effect(() => {
		if (!showTestLayer || !testLayerElement) return;
		return transientLayers.register({
			id: 'test-dialog',
			kind: 'application-dialog',
			modality: 'main-inert',
			element: () => testLayerElement,
			onEscape: () => {
				showTestLayer = false;
				return true;
			},
			restoreFocus: () => {},
		});
	});
</script>

<KeyboardShortcuts />
<button type="button" onclick={() => (showTestLayer = true)}>Open test layer</button>
{#if showTestLayer}
	<div bind:this={testLayerElement} role="dialog" tabindex="-1" aria-label="Test dialog"></div>
{/if}
<ConversationWorkspace isVisible={true} />
