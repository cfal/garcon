<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as m from '$lib/paraglide/messages.js';
	import SidebarSearchPanel from './SidebarSearchPanel.svelte';
	import type { SidebarSearchPanelProps } from './sidebar-search-panel';

	interface SidebarSearchDialogProps extends SidebarSearchPanelProps {
		open: boolean;
	}

	let { open, onClose, ...panelProps }: SidebarSearchDialogProps = $props();
</script>

<Dialog.Root {open} requestClose={onClose}>
	<Dialog.Content
		data-search-dialog-content
		class="top-[var(--app-viewport-center-y)] flex h-[var(--app-height)] max-h-[var(--app-height)] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:w-screen sm:max-w-none min-[769px]:pointer-fine:top-[50%] min-[769px]:pointer-fine:h-[min(44rem,calc(var(--app-height)-2rem))] min-[769px]:pointer-fine:max-h-[44rem] min-[769px]:pointer-fine:w-[calc(100vw-2rem)] min-[769px]:pointer-fine:max-w-3xl min-[769px]:pointer-fine:rounded-2xl min-[769px]:pointer-fine:border"
		showCloseButton={false}
	>
		<Dialog.Title class="sr-only">{m.sidebar_projects_search_placeholder()}</Dialog.Title>
		<SidebarSearchPanel {...panelProps} {onClose} />
	</Dialog.Content>
</Dialog.Root>
