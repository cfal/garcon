<script lang="ts">
	// Modal dialog wrapper for the new-chat form. Mounts at the AppShell
	// level so it overlays any active tab. Orchestrates draft creation
	// and navigation on submit.

	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell, getChatSessions, getWorkspaceCoordinator } from '$lib/context';
	import type { ChatId } from '$shared/chat-id';
	import { gotoChat } from '$lib/chat/actions/chat-navigation.js';
	import type { NewChatConfig } from '$lib/chat/sessions/chat-session-types';
	import NewChatForm from './NewChatForm.svelte';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	const appShell = getAppShell();
	const workspace = getWorkspaceCoordinator();
	const sessions = getChatSessions();

	const open = $derived(appShell.newChatDialogOpen);

	function handleOpenChange(next: boolean) {
		if (!next) appShell.closeNewChatDialog();
	}

	function handleStartChat(config: NewChatConfig, chatId: ChatId) {
		sessions.createDraft({
			id: chatId,
			projectPath: config.projectPath,
			startup: {
				executorId: config.executorId,
				agentId: config.agentId,
				model: config.model,
				apiProviderId: config.apiProviderId ?? null,
				modelEndpointId: config.modelEndpointId ?? null,
				modelProtocol: config.modelProtocol ?? null,
				permissionMode: config.permissionMode,
				thinkingMode: config.thinkingMode,
				agentSettings: config.agentSettings,
				firstMessage: config.firstMessage,
				initialImages: config.initialImages,
				tags: config.tags,
				orderedPreambleIds: config.orderedPreambleIds,
			},
		});

		appShell.closeNewChatDialog();
		void workspace.focusChat();
		void gotoChat(chatId).finally(() => appShell.requestComposerFocus());
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="top-(--app-viewport-offset-top) left-0 flex h-(--app-height) max-h-(--app-height) max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background p-0 shadow-none sm:max-w-none"
		data-new-chat-landing
		showCloseButton={false}
		onOpenAutoFocus={(e) => {
			// Prevent default auto-focus on the first input (project path),
			// which would immediately trigger the directory browser overlay.
			// The form focuses the textarea after its startup defaults load.
			e.preventDefault();
		}}
	>
		<header class="landing-insets flex shrink-0 items-center justify-between gap-4 py-3">
			<Dialog.Title class="text-sm font-medium">{m.command_new_chat()}</Dialog.Title>
			<button
				type="button"
				onclick={() => appShell.closeNewChatDialog()}
				aria-label={m.common_close()}
				class="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<X class="size-5" aria-hidden="true" />
			</button>
		</header>
		<div
			class="landing-insets min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(1rem,var(--safe-area-inset-bottom,0px))]"
		>
			<div class="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center py-6 sm:py-12">
				<div class="mb-6 space-y-2">
					<h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">
						{m.chat_new_chat_landing_heading()}
					</h2>
					<Dialog.Description>{m.chat_new_chat_landing_description()}</Dialog.Description>
				</div>
				{#key appShell.newChatDialogRequestId}
					<NewChatForm
						seed={appShell.newChatDialogSeed}
						onStartChat={handleStartChat}
						onCancel={() => appShell.closeNewChatDialog()}
					/>
				{/key}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	.landing-insets {
		padding-left: max(1rem, var(--safe-area-inset-left, 0px));
		padding-right: max(1rem, var(--safe-area-inset-right, 0px));
	}

	@media (min-width: 640px) {
		.landing-insets {
			padding-left: max(1.5rem, var(--safe-area-inset-left, 0px));
			padding-right: max(1.5rem, var(--safe-area-inset-right, 0px));
		}
	}
</style>
