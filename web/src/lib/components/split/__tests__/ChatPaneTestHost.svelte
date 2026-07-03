	<script lang="ts">
		import ChatPane from '../ChatPane.svelte';
		import {
			setAppShell,
			setChatSessions,
			setFileViewer,
			setLocalSettings,
			setSplitLayout,
		} from '$lib/context';
		import { SplitPanePreviewStore } from '$lib/chat/split-pane-preview-store.svelte';

	interface Props {
		isFocused?: boolean;
		textScale?: number;
		onFocus?: () => void;
		onMaximize?: () => void;
	}

	let {
		isFocused = false,
		textScale = 1,
		onFocus = () => {},
		onMaximize = () => {},
	}: Props = $props();
	const previewStore = new SplitPanePreviewStore();

	setChatSessions({
		byId: {
			'chat-1': {
					id: 'chat-1',
					title: 'Pane Test Chat',
					agentId: 'codex',
					projectPath: '/workspace/project',
					isProcessing: false,
				},
			},
			selectedChat: { id: 'chat-2', projectPath: '/workspace/other' },
		} as never);

	setFileViewer({
		openAuto: () => {},
	} as never);

	setAppShell({
		projectBasePath: '/workspace',
		openNewChatDialog: () => {},
	} as never);

	setLocalSettings({
		autoExpandTools: false,
		showThinking: true,
		showQuickCommitTray: true,
		chatMaxWidth: 'none',
	} as never);

	setSplitLayout({
		draggedPaneId: null,
		startPaneDrag() {},
		endDrag() {},
		swapPanes() {},
	} as never);
</script>

{#snippet focusedContent()}
	<div data-testid="focused-workspace">Focused workspace</div>
{/snippet}

	<ChatPane
		paneId="pane-1"
		chatId="chat-1"
		{isFocused}
		{previewStore}
		{textScale}
		{onFocus}
	onClose={() => {}}
	{onMaximize}
	{focusedContent}
/>
