<script lang="ts">
	// Modal dialog wrapper for the new-chat form. Mounts at the AppShell
	// level so it overlays any active tab. Orchestrates draft creation
	// and navigation on submit.

	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell, getNavigation, getChatSessions } from '$lib/context';
	import { createClientChatId } from '$lib/chat/client-id.js';
	import type { PermissionMode } from '$lib/types/chat';
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
				permissionMode: config.permissionMode as PermissionMode,
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
		class="sm:max-w-3xl max-h-[90dvh] overflow-y-auto p-0"
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
