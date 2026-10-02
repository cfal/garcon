<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as m from '$lib/paraglide/messages.js';
	import SidebarSearchPanel from './SidebarSearchPanel.svelte';
	import {
		SIDEBAR_SEARCH_DIALOG_CONTENT_CLASS,
		type SidebarSearchPanelProps,
	} from './sidebar-search-panel';

	interface SidebarSearchDialogProps extends SidebarSearchPanelProps {
		open: boolean;
	}

	let { open, onClose, ...panelProps }: SidebarSearchDialogProps = $props();
</script>

<Dialog.Root {open} requestClose={onClose}>
	<Dialog.Content
		data-search-dialog-content
		class={SIDEBAR_SEARCH_DIALOG_CONTENT_CLASS}
		showCloseButton={false}
	>
		<Dialog.Title class="sr-only">{m.sidebar_projects_search_placeholder()}</Dialog.Title>
		<SidebarSearchPanel {...panelProps} {onClose} />
	</Dialog.Content>
</Dialog.Root>
