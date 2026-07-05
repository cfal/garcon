<script lang="ts">
	import ConversationWorkspace from '../ConversationWorkspace.svelte';
	import {
		setAppShell,
		setChatSessions,
		setLocalSettings,
		setModelCatalog,
		setNavigation,
		setReadReceiptOutbox,
		setRemoteSettings,
		setWs,
	} from '$lib/context';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { DrainCursor } from '$lib/ws/connection.svelte';

	const selectedChat: ChatSessionRecord = {
		id: 'chat-1',
		projectPath: '/workspace/project',
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
		promoteDraft: () => {},
		removeChat: () => {},
		setSelectedChatId: () => {},
		setChatProcessing: () => {},
		reconcileProcessing: () => {},
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
	setNavigation({
		setActiveTab: () => {},
		navigateToChat: () => {},
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
</script>

<ConversationWorkspace isVisible={true} />
