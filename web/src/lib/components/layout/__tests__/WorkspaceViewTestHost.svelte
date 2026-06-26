<script lang="ts">
	import WorkspaceView from '../WorkspaceView.svelte';
	import {
		setAppShell,
		setChatSessions,
		setModelCatalog,
		setLocalSettings,
		setSplitLayout,
		setWs,
	} from '$lib/context';
	import type { AppTab } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface WorkspaceChatActions {
		requestDelete: (chat: ChatSessionRecord) => void;
		requestRename: (chat: ChatSessionRecord) => void;
		requestDetails: (chat: ChatSessionRecord) => void;
		requestShare: (chat: ChatSessionRecord) => void;
		requestProjectPath: (chat: ChatSessionRecord) => void;
		reload: (chat: ChatSessionRecord) => void;
	}

	interface WorkspaceViewTestHostProps {
		activeTab: AppTab;
		alwaysFullscreenOnGitPanel?: boolean;
		isMobile?: boolean;
		isDesktopFullscreen?: boolean;
		chatSessions?: unknown;
		splitLayout?: unknown;
		chatActions?: WorkspaceChatActions;
	}

	let {
		activeTab,
		alwaysFullscreenOnGitPanel = true,
		isMobile = false,
		isDesktopFullscreen = false,
		chatSessions,
		splitLayout,
		chatActions,
	}: WorkspaceViewTestHostProps = $props();

	const defaultChatActions: WorkspaceChatActions = {
		requestDelete() {},
		requestRename() {},
		requestDetails() {},
		requestShare() {},
		requestProjectPath() {},
		reload() {},
	};

	function getChatSessionsContext(): unknown {
		return (
			chatSessions ?? {
				selectedChat: {
					id: 'chat-1',
					title: 'Header Test Chat',
					projectPath: '/tmp/header-test',
				},
				byId: {
					'chat-1': {
						id: 'chat-1',
						title: 'Header Test Chat',
						projectPath: '/tmp/header-test',
					},
				},
				orderedChats: [],
				isLoadingChats: false,
				setSelectedChatId() {},
				quietRefreshChats() {},
				deleteRemoteChat() {},
			}
		);
	}

	setChatSessions(getChatSessionsContext() as never);

	setLocalSettings({
		get alwaysFullscreenOnGitPanel() {
			return alwaysFullscreenOnGitPanel;
		},
	} as never);

	setModelCatalog({
		version: 0,
		getModels() {
			return [];
		},
		getAgents() {
			return ['claude', 'codex', 'opencode'];
		},
		getSelectableAgents() {
			return ['claude', 'codex', 'opencode'];
		},
		supportsUpdateProjectPath() {
			return true;
		},
	} as never);

	function getSplitLayoutContext(): unknown {
		return (
			splitLayout ?? {
				isEnabled: false,
				root: null,
				focusedPaneId: null,
				draggedChatId: null,
				draggedPaneId: null,
				panes: [],
				focusedChatId: null,
			}
		);
	}

	setSplitLayout(getSplitLayoutContext() as never);

	setAppShell({
		openNewChatDialog() {},
	} as never);

	setWs({
		isConnected: false,
	} as never);

	function handleTabChange(_tab: AppTab): void {
		// No-op for rendering tests.
	}
</script>

<WorkspaceView
	{activeTab}
	onTabChange={handleTabChange}
	onMenuClick={isMobile ? () => {} : undefined}
	{isDesktopFullscreen}
	onToggleDesktopFullscreen={isMobile ? undefined : () => {}}
	chatActions={chatActions ?? defaultChatActions}
/>
