<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { gotoChat } from '$lib/chat/actions/chat-navigation.js';
	import { getAppShell } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import ScheduledPromptsSection from './ScheduledPromptsSection.svelte';
	import ScheduledPromptHeader from './ScheduledPromptHeader.svelte';

	const appShell = getAppShell();

	function handleOpenChange(open: boolean): void {
		if (!open) appShell.closeScheduledPrompts();
	}

	function openChat(chatId: string): void {
		appShell.closeScheduledPrompts();
		void gotoChat(chatId);
	}
</script>

<Dialog.Root open={appShell.showScheduledPrompts} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[80dvh] sm:max-h-[44rem] sm:max-w-3xl sm:rounded-lg sm:border"
		showCloseButton={false}
	>
		<ScheduledPromptHeader
			title={m.scheduled_prompts_title()}
			description={m.scheduled_prompts_description()}
			onClose={() => appShell.closeScheduledPrompts()}
		/>

		<div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
			<ScheduledPromptsSection active={appShell.showScheduledPrompts} onOpenChat={openChat} />
		</div>
	</Dialog.Content>
</Dialog.Root>
