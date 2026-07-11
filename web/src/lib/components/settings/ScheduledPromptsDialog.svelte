<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import ScheduledPromptsSection from './ScheduledPromptsSection.svelte';

	const appShell = getAppShell();

	function handleOpenChange(open: boolean): void {
		if (!open) appShell.closeScheduledPrompts();
	}
</script>

<Dialog.Root open={appShell.showScheduledPrompts} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[80dvh] sm:max-h-[44rem] sm:max-w-3xl sm:rounded-lg sm:border"
		showCloseButton={true}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 sm:px-6">
			<Dialog.Title class="text-lg font-semibold">{m.scheduled_prompts_title()}</Dialog.Title>
			<Dialog.Description>{m.scheduled_prompts_description()}</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
			<ScheduledPromptsSection active={appShell.showScheduledPrompts} />
		</div>
	</Dialog.Content>
</Dialog.Root>
