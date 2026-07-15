<script lang="ts">
	// Modal dialog wrapper for the new-chat form. Mounts at the AppShell
	// level so it overlays any active tab. Orchestrates draft creation
	// and navigation on submit.

	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell, getChatSessions, getWorkspaceCoordinator } from '$lib/context';
	import { createClientChatId } from '$lib/chat/client-id.js';
	import { gotoChat } from '$lib/chat/chat-navigation';
	import type { NewChatConfig } from '$lib/types/app';
	import NewChatForm from './NewChatForm.svelte';

	const appShell = getAppShell();
	const workspace = getWorkspaceCoordinator();
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
				agentId: config.agentId,
				model: config.model,
				apiProviderId: config.apiProviderId ?? null,
				modelEndpointId: config.modelEndpointId ?? null,
				modelProtocol: config.modelProtocol ?? null,
				permissionMode: config.permissionMode,
				thinkingMode: config.thinkingMode,
				claudeThinkingMode: config.claudeThinkingMode,
				ampAgentMode: config.ampAgentMode ?? 'smart',
				firstMessage: config.firstMessage,
				initialImages: config.initialImages,
				tags: config.tags,
			},
		});

		appShell.closeNewChatDialog();
		void workspace.focusChat();
		void gotoChat(chatId).finally(() => appShell.requestComposerFocus());
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="top-[var(--app-viewport-center-y)] h-auto max-h-[calc(var(--app-height)-1rem)] w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto p-0 sm:top-[50%] sm:w-full sm:max-h-[90dvh] sm:max-w-3xl"
		showCloseButton={false}
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
