<script lang="ts">
	import WorkspaceView from '../WorkspaceView.svelte';
	import {
		setChatSessions,
		setModelCatalog,
		setLocalSettings,
		setSplitLayout,
		setAppShell,
		setWs,
		setNotifications,
	} from '$lib/context';
	import type { AppTab } from '$lib/types/app';

	interface WorkspaceViewTestHostProps {
		activeTab: AppTab;
		alwaysFullscreenOnGitPanel?: boolean;
		isMobile?: boolean;
		isDesktopFullscreen?: boolean;
		chatSessions?: unknown;
		splitLayout?: unknown;
	}

	let {
		activeTab,
		alwaysFullscreenOnGitPanel = true,
		isMobile = false,
		isDesktopFullscreen = false,
		chatSessions,
		splitLayout,
	}: WorkspaceViewTestHostProps = $props();

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
				setSelectedChatId() {},
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
		quietRefreshChats() {},
	} as never);

	setWs({
		isConnected: false,
	} as never);

	setNotifications({
		error() {},
		info() {},
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
/>
