<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import PreamblesSection from './PreamblesSection.svelte';

	const appShell = getAppShell();

	function handleOpenChange(open: boolean): void {
		if (!open) appShell.closePreambles();
	}
</script>

<Dialog.Root open={appShell.showPreambles} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="top-[var(--app-viewport-center-y)] flex h-[var(--app-height)] max-h-[var(--app-height)] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:w-[calc(100vw-2rem)] sm:pointer-fine:top-[50%] sm:pointer-fine:h-[min(44rem,calc(var(--app-height)-2rem))] sm:pointer-fine:max-h-[44rem] sm:pointer-fine:max-w-3xl sm:pointer-fine:rounded-lg sm:pointer-fine:border"
		showCloseButton={true}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 sm:px-6">
			<Dialog.Title class="text-lg font-semibold">{m.preambles_title()}</Dialog.Title>
			<Dialog.Description>{m.preambles_description()}</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
			<PreamblesSection active={appShell.showPreambles} />
		</div>
	</Dialog.Content>
</Dialog.Root>
