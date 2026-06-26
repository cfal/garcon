<script lang="ts">
	import SidebarProjectPathDialog from '$lib/components/sidebar/SidebarProjectPathDialog.svelte';
	import type { ChatProjectPathDialog } from './chat-action-dialogs-state.svelte';

	interface ChatProjectPathDialogProps {
		projectPathDialog: ChatProjectPathDialog | null;
		projectBasePath: string;
		isMobile: boolean;
		onClose: () => void;
		onConfirm: (chatId: string, projectPath: string) => Promise<void> | void;
	}

	let {
		projectPathDialog,
		projectBasePath,
		isMobile,
		onClose,
		onConfirm,
	}: ChatProjectPathDialogProps = $props();
</script>

<SidebarProjectPathDialog
	{projectPathDialog}
	{projectBasePath}
	{isMobile}
	{onClose}
	{onConfirm}
/>
