<script lang="ts">
	import WorkspaceView from '../WorkspaceView.svelte';
	import { setChatSessions, setModelCatalog, setPreferences } from '$lib/context';
	import type { AppTab } from '$lib/types/app';

	interface WorkspaceViewTestHarnessProps {
		activeTab: AppTab;
		showChatHeader: boolean;
		alwaysFullscreenOnGitPanel?: boolean;
		isMobile?: boolean;
		isDesktopFullscreen?: boolean;
	}

	let {
		activeTab,
		showChatHeader,
		alwaysFullscreenOnGitPanel = true,
		isMobile = false,
		isDesktopFullscreen = false
	}: WorkspaceViewTestHarnessProps = $props();

	setChatSessions({
		selectedChat: {
			id: 'chat-1',
			title: 'Header Test Chat',
			projectPath: '/tmp/header-test'
		}
	} as never);

	setPreferences({
		get showChatHeader() {
			return showChatHeader;
		},
		get alwaysFullscreenOnGitPanel() {
			return alwaysFullscreenOnGitPanel;
		},
	} as never);

	setModelCatalog({
		version: 0,
		getModels() {
			return [];
		},
		getProviders() {
			return ['claude', 'codex', 'opencode', 'amp'];
		}
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
