<script lang="ts">
	import Sidebar from '../Sidebar.svelte';
	import { setAppShell, setModelCatalog, setReadReceiptOutbox, setSplitLayout } from '$lib/context';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarHostProps {
		chats?: ChatSessionRecord[];
		isMobile?: boolean;
	}

	let { chats = [], isMobile = false }: SidebarHostProps = $props();

	setAppShell({
		onSidebarRecenterRequested() {
			return () => {};
		},
		onRenameSelectedChatRequested() {
			return () => {};
		},
		onDeleteSelectedChatRequested() {
			return () => {};
		},
		onSidebarSearchRequested() {
			return () => {};
		},
		requestSidebarRecenterToSelected() {},
		requestComposerFocus() {},
	} as never);

	setReadReceiptOutbox({
		markChatsReadNow() {
			return Promise.resolve();
		},
	} as never);

	setModelCatalog({
		supportsFork() {
			return true;
		},
	} as never);

	setSplitLayout({
		isEnabled: false,
		startDrag() {},
		endDrag() {},
	} as never);
</script>

<Sidebar
	{chats}
	selectedChatId={null}
	isLoading={false}
	{isMobile}
	onChatSelect={() => {}}
	onNewChat={() => {}}
	onQuietRefresh={() => Promise.resolve()}
	onShowSettings={() => {}}
/>
