<!-- Main settings modal. Single scrollable dialog with agents and
     preferences sections. Scrolls to the target section on open. -->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import { getAppShell } from '$lib/context';
	import AgentsSection from './AgentsSection.svelte';
	import PreferencesSection from './PreferencesSection.svelte';

	const appShell = getAppShell();

	let scrollContainer = $state<HTMLDivElement | null>(null);

	// Scroll to the requested section when the dialog opens.
	// Skips 'agents' since it is already the first visible section.
	$effect(() => {
		if (appShell.showSettings && scrollContainer) {
			const section = appShell.settingsInitialSection;
			if (section && section !== 'agents') {
				requestAnimationFrame(() => {
					const target = scrollContainer?.querySelector(`[data-section="${section}"]`);
					target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
				});
			}
		}
	});

	function handleOpenChange(open: boolean) {
		if (!open) {
			appShell.closeSettings();
		}
	}
</script>

<Dialog.Root open={appShell.showSettings} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="sm:max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden"
		showCloseButton={true}
	>
		<Dialog.Header class="px-6 py-3 border-b border-border">
			<Dialog.Title class="text-lg font-semibold">{m.settings_title()}</Dialog.Title>
			<Dialog.Description class="sr-only">{m.settings_title()}</Dialog.Description>
		</Dialog.Header>

		<div
			class="flex-1 min-h-0 overflow-y-auto px-6 py-6"
			bind:this={scrollContainer}
		>
			<div class="space-y-8">
				<AgentsSection />
				<PreferencesSection />
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
