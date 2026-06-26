<script lang="ts">
	import ChatActionDialogs from '$lib/components/chat/ChatActionDialogs.svelte';
	import type {
		ChatDeleteConfirmation,
		ChatDetailsDialog,
		ChatRenameConfirmation,
	} from '$lib/components/chat/chat-action-dialogs-state.svelte';

	interface SidebarChatDialogsProps {
		chatDeleteConfirmation: ChatDeleteConfirmation | null;
		onCancelDelete: () => void;
		onConfirmDelete: () => void;
		chatRenameConfirmation: ChatRenameConfirmation | null;
		onCancelRename: () => void;
		onConfirmRename: (newName: string) => void;
		chatDetailsDialog: ChatDetailsDialog | null;
		onCloseDetails: () => void;
	}

	let {
		chatDeleteConfirmation,
		onCancelDelete,
		onConfirmDelete,
		chatRenameConfirmation,
		onCancelRename,
		onConfirmRename,
		chatDetailsDialog,
		onCloseDetails,
	}: SidebarChatDialogsProps = $props();
</script>

<ChatActionDialogs
	{chatDeleteConfirmation}
	{onCancelDelete}
	{onConfirmDelete}
	{chatRenameConfirmation}
	{onCancelRename}
	{onConfirmRename}
	{chatDetailsDialog}
	{onCloseDetails}
/>
