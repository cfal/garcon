<!-- Renders the settings dialog as one scrollable page. -->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import { getAppShell, getRemoteSettings } from '$lib/context';
	import ApiProvidersSection from './ApiProvidersSection.svelte';
	import LocalSettingsSection from './LocalSettingsSection.svelte';
	import RemoteSettingsSection from './RemoteSettingsSection.svelte';

	const appShell = getAppShell();
	const remoteSettings = getRemoteSettings();
	let scrollContainer = $state<HTMLDivElement | null>(null);

	// Refreshes remote settings on open and scrolls to the requested
	// section without remounting the dialog body.
	$effect(() => {
		if (!appShell.showSettings || !scrollContainer) return;
		void remoteSettings.refreshInBackground();
		requestAnimationFrame(() => {
			const target = scrollContainer?.querySelector(
				`[data-section="${appShell.settingsInitialTab}"]`
			);
			target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
		});
	});

	function handleOpenChange(open: boolean) {
		if (!open) appShell.closeSettings();
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

		<div class="flex-1 min-h-0 overflow-y-auto px-6 py-6" bind:this={scrollContainer}>
			<div class="space-y-8">
				<div data-section="api-providers" class="space-y-3">
					<ApiProvidersSection />
				</div>

				<div data-section="local" class="space-y-3">
					<div class="space-y-1">
						<h2 class="text-base font-semibold text-foreground">
							{m.settings_tab_local()}
						</h2>
						<p class="text-sm text-muted-foreground">
							{m.settings_scope_local_description()}
						</p>
					</div>
					<LocalSettingsSection />
				</div>

				<div data-section="remote" class="space-y-3">
					<div class="space-y-1">
						<h2 class="text-base font-semibold text-foreground">
							{m.settings_tab_remote()}
						</h2>
						<p class="text-sm text-muted-foreground">
							{m.settings_scope_remote_description()}
						</p>
					</div>
					<RemoteSettingsSection />
				</div>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
