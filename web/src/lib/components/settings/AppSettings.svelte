<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as m from '$lib/paraglide/messages.js';
	import { getAppShell } from '$lib/context';
	import LocalSettingsSection from './LocalSettingsSection.svelte';
	import KeyboardShortcutsSection from './KeyboardShortcutsSection.svelte';

	const appShell = getAppShell();
	let scrollContainer = $state<HTMLDivElement | null>(null);

	function handleTabChange(value: string): void {
		appShell.setAppSettingsTab(value);
		requestAnimationFrame(() => scrollContainer?.scrollTo({ top: 0 }));
	}
</script>

<Dialog.Root
	open={appShell.showAppSettings}
	onOpenChange={(open) => {
		if (!open) appShell.closeAppSettings();
	}}
>
	<Dialog.Content
		class="safe-viewport-dialog sm:max-w-3xl h-[80dvh] max-h-[44rem] flex flex-col gap-0 p-0 overflow-hidden"
	>
		<Dialog.Header class="px-6 py-3 border-b border-border">
			<Dialog.Title class="text-lg font-semibold">{m.app_settings_title()}</Dialog.Title>
			<Dialog.Description class="sr-only">{m.settings_scope_local_description()}</Dialog.Description
			>
		</Dialog.Header>
		<Tabs.Root
			value={appShell.appSettingsTab}
			onValueChange={handleTabChange}
			class="min-h-0 flex-1 gap-0"
		>
			<div class="border-b border-border px-4 py-3 sm:px-6">
				<Tabs.List class="grid h-auto w-full grid-cols-2" aria-label={m.app_settings_title()}>
					<Tabs.Trigger value="general" class="h-8 px-2">{m.settings_tab_general()}</Tabs.Trigger>
					<Tabs.Trigger value="shortcuts" class="h-8 px-2"
						>{m.settings_tab_shortcuts()}</Tabs.Trigger
					>
				</Tabs.List>
			</div>
			<div class="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6" bind:this={scrollContainer}>
				<Tabs.Content value="general" class="mt-0 space-y-6">
					{#if appShell.appSettingsTab === 'general'}
						<LocalSettingsSection />
					{/if}
				</Tabs.Content>
				<Tabs.Content value="shortcuts" class="mt-0 space-y-6">
					{#if appShell.appSettingsTab === 'shortcuts'}
						<KeyboardShortcutsSection />
					{/if}
				</Tabs.Content>
			</div>
		</Tabs.Root>
	</Dialog.Content>
</Dialog.Root>
