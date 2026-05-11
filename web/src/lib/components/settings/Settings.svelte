<!-- Renders the settings dialog as tabbed, scrollable sections. -->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as m from '$lib/paraglide/messages.js';
	import { getAppShell, getModelCatalog, getRemoteSettings } from '$lib/context';
	import ApiProvidersSection from './ApiProvidersSection.svelte';
	import OtherHarnessesSection from './OtherHarnessesSection.svelte';
	import LocalSettingsSection from './LocalSettingsSection.svelte';
	import RemoteSettingsSection from './RemoteSettingsSection.svelte';
	import { SettingsAuthState } from './settings-auth-state.svelte.js';

	const appShell = getAppShell();
	const remoteSettings = getRemoteSettings();
	const settingsAuth = new SettingsAuthState(getModelCatalog());
	let scrollContainer = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!appShell.showSettings) return;
		void remoteSettings.refreshInBackground();
		const cleanup = settingsAuth.initialize();
		return cleanup;
	});

	function handleOpenChange(open: boolean) {
		if (!open) appShell.closeSettings();
	}

	function handleTabChange(value: string) {
		appShell.setSettingsTab(value);
		requestAnimationFrame(() => {
			scrollContainer?.scrollTo({ top: 0 });
		});
	}
</script>

{#snippet tabDescription(description: string)}
	<p class="text-sm text-muted-foreground">{description}</p>
{/snippet}

<Dialog.Root open={appShell.showSettings} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="sm:max-w-3xl h-[80vh] max-h-[44rem] flex flex-col gap-0 p-0 overflow-hidden"
		showCloseButton={true}
	>
		<Dialog.Header class="px-6 py-3 border-b border-border">
			<Dialog.Title class="text-lg font-semibold">{m.settings_title()}</Dialog.Title>
			<Dialog.Description class="sr-only">{m.settings_title()}</Dialog.Description>
		</Dialog.Header>

		<Tabs.Root
			value={appShell.settingsTab}
			onValueChange={handleTabChange}
			class="min-h-0 flex-1 gap-0"
		>
			<div class="border-b border-border px-4 py-3 sm:px-6">
				<Tabs.List class="grid h-auto w-full grid-cols-2 sm:grid-cols-4">
					<Tabs.Trigger value="providers" class="h-8 px-2">
						{m.settings_tab_providers()}
					</Tabs.Trigger>
					<Tabs.Trigger value="other-harnesses" class="h-8 px-2">
						{m.settings_tab_other_harnesses()}
					</Tabs.Trigger>
					<Tabs.Trigger value="local" class="h-8 px-2">
						{m.settings_tab_local_settings()}
					</Tabs.Trigger>
					<Tabs.Trigger value="remote" class="h-8 px-2">
						{m.settings_tab_remote_settings()}
					</Tabs.Trigger>
				</Tabs.List>
			</div>

			<div class="flex-1 min-h-0 overflow-y-auto px-6 py-6" bind:this={scrollContainer}>
				<Tabs.Content value="providers" class="mt-0 space-y-6">
					{@render tabDescription(m.settings_providers_description())}
					<ApiProvidersSection {settingsAuth} />
				</Tabs.Content>

				<Tabs.Content value="other-harnesses" class="mt-0 space-y-6">
					<OtherHarnessesSection {settingsAuth} />
				</Tabs.Content>

				<Tabs.Content value="local" class="mt-0 space-y-6">
					{@render tabDescription(m.settings_scope_local_description())}
					<LocalSettingsSection />
				</Tabs.Content>

				<Tabs.Content value="remote" class="mt-0 space-y-6">
					{@render tabDescription(m.settings_scope_remote_description())}
					<RemoteSettingsSection />
				</Tabs.Content>
			</div>
		</Tabs.Root>
	</Dialog.Content>
</Dialog.Root>
