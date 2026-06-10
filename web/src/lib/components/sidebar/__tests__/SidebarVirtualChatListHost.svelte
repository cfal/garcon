<script lang="ts">
	import SidebarVirtualChatList from '../SidebarVirtualChatList.svelte';
	import { setAppShell, setModelCatalog, setSplitLayout } from '$lib/context';
	import type { SidebarVirtualChatRow } from '../sidebar-virtual-chat-list';

	interface SidebarVirtualChatListHostProps {
		rows: SidebarVirtualChatRow[];
		selectedChatId?: string | null;
		isMobile?: boolean;
		rowHeight?: number;
		onRegisterRecenter?: (callback: () => void) => void;
	}

	let {
		rows,
		selectedChatId = null,
		isMobile = false,
		rowHeight,
		onRegisterRecenter,
	}: SidebarVirtualChatListHostProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);

	setAppShell({
		onSidebarRecenterRequested(callback: () => void) {
			onRegisterRecenter?.(callback);
			return () => {};
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

<div
	bind:this={viewportRef}
	data-testid="virtual-sidebar-viewport"
	style="height:640px; overflow-y:auto;"
>
	<SidebarVirtualChatList
		{rows}
		{viewportRef}
		{selectedChatId}
		currentTime={new Date('2025-01-01T03:00:00.000Z')}
		{isMobile}
		{rowHeight}
		onChatSelect={() => {}}
		onDeleteChat={() => {}}
		onStartRenameChat={() => {}}
		onTogglePinned={() => {}}
		onToggleArchive={() => {}}
		onShowDetails={() => {}}
		onForkChat={() => {}}
		onShareChat={() => {}}
		onEnterReorderMode={() => {}}
	/>
</div>
