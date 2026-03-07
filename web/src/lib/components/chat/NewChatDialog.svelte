<script lang="ts">
	// Modal dialog wrapper for the new-chat form. Mounts at the AppShell
	// level so it overlays any active tab. Orchestrates draft creation
	// and navigation on submit.

	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell, getNavigation, getChatSessions } from '$lib/context';
	import { createClientChatId } from '$lib/chat/client-id.js';
	import type { NewChatConfig } from '$lib/types/app';
	import NewChatForm from './NewChatForm.svelte';
	import { goto } from '$app/navigation';

	const appShell = getAppShell();
	const navigation = getNavigation();
	const sessions = getChatSessions();

	const open = $derived(appShell.newChatDialogOpen);
	const prefill = $derived(appShell.newChatDialogSeed?.prefill ?? '');

	function handleOpenChange(next: boolean) {
		if (!next) appShell.closeNewChatDialog();
	}

	function handleStartChat(config: NewChatConfig) {
		const chatId = createClientChatId();

		sessions.createDraft({
			id: chatId,
			projectPath: config.projectPath,
			startup: {
				provider: config.provider,
				model: config.model,
				permissionMode: config.permissionMode,
				thinkingMode: config.thinkingMode,
				firstMessage: config.firstMessage,
				initialImages: config.initialImages,
			},
		});

		appShell.closeNewChatDialog();
		navigation.setActiveTab('chat');
		goto(`/chat/${chatId}`);
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="top-auto bottom-0 left-0 w-full max-w-none translate-x-0 translate-y-0 h-auto max-h-[88dvh] rounded-t-2xl rounded-b-none border-x-0 border-b-0 overflow-x-hidden overflow-y-auto p-0 sm:top-[50%] sm:bottom-auto sm:left-[50%] sm:w-full sm:max-h-[90dvh] sm:max-w-3xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border sm:border-x sm:border-b"
		showCloseButton={true}
		onOpenAutoFocus={(e) => {
			// Prevent default auto-focus on the first input (project path),
			// which would immediately trigger the directory browser overlay.
			// The form's reseed effect handles focusing the textarea instead.
			e.preventDefault();
		}}
	>
		<NewChatForm
			{prefill}
			onStartChat={handleStartChat}
			onCancel={() => appShell.closeNewChatDialog()}
		/>
	</Dialog.Content>
</Dialog.Root>
