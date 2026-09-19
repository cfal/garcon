<!-- Renders the settings dialog as tabbed, scrollable sections. -->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as m from '$lib/paraglide/messages.js';
	import { getAppShell, getModelCatalog, getRemoteSettings, getExecutionNodes } from '$lib/context';
	import { untrack } from 'svelte';
	import ApiProvidersSection from './ApiProvidersSection.svelte';
	import OtherAgentsSection from './OtherAgentsSection.svelte';
	import LocalSettingsSection from './LocalSettingsSection.svelte';
	import RemoteSettingsSection from './RemoteSettingsSection.svelte';
	import KeyboardShortcutsSection from './KeyboardShortcutsSection.svelte';
	import { SettingsAuthState } from './settings-auth-state.svelte.js';

	const appShell = getAppShell();
	const remoteSettings = getRemoteSettings();
	const modelCatalog = getModelCatalog();
	const executionNodes = getExecutionNodes();
	let nodeId = $state('local');
	const settingsAuth = $derived(new SettingsAuthState(modelCatalog.forNode(nodeId), nodeId));
	let scrollContainer = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!appShell.showSettings) return;
		void remoteSettings.refreshInBackground();
		void executionNodes.refresh();
	});

	$effect(() => {
		if (!appShell.showSettings || !['providers', 'other-agents'].includes(appShell.settingsTab)) return;
		const auth = settingsAuth;
		if (!executionNodes.isReady(nodeId)) return;
		return untrack(() => auth.initialize());
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
				<Tabs.List class="grid h-auto w-full grid-cols-2 sm:grid-cols-5">
					<Tabs.Trigger value="providers" class="h-8 px-2">
						{m.settings_tab_providers()}
					</Tabs.Trigger>
					<Tabs.Trigger value="other-agents" class="h-8 px-2">
						{m.settings_tab_other_agents()}
					</Tabs.Trigger>
					<Tabs.Trigger value="remote" class="h-8 px-2">
						{m.settings_tab_remote_settings()}
					</Tabs.Trigger>
					<Tabs.Trigger value="local" class="h-8 px-2">
						{m.settings_tab_local_settings()}
					</Tabs.Trigger>
					<Tabs.Trigger value="shortcuts" class="h-8 px-2">
						{m.settings_tab_shortcuts()}
					</Tabs.Trigger>
				</Tabs.List>
				{#if appShell.settingsTab === 'providers' || appShell.settingsTab === 'other-agents'}
					<label class="mt-3 flex items-center gap-3 text-sm">
						<span class="shrink-0">Execution node</span>
						<select bind:value={nodeId} class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-base sm:pointer-fine:text-sm">
							{#each executionNodes.nodes as node (node.id)}
								<option value={node.id}>{node.label}{node.availability === 'ready' ? '' : ' (Unavailable)'}</option>
							{/each}
						</select>
					</label>
				{/if}
			</div>

			<div class="flex-1 min-h-0 overflow-y-auto px-6 py-6" bind:this={scrollContainer}>
				<Tabs.Content value="providers" class="mt-0 space-y-6">
					{@render tabDescription(m.settings_providers_description())}
					{#if executionNodes.isReady(nodeId)}
						<ApiProvidersSection {settingsAuth} {nodeId} />
					{:else}
						<p class="text-sm text-muted-foreground">{executionNodes.label(nodeId)} is unavailable.</p>
					{/if}
				</Tabs.Content>

				<Tabs.Content value="other-agents" class="mt-0 space-y-6">
					{#if executionNodes.isReady(nodeId)}
						<OtherAgentsSection {settingsAuth} />
					{:else}
						<p class="text-sm text-muted-foreground">{executionNodes.label(nodeId)} is unavailable.</p>
					{/if}
				</Tabs.Content>

				<Tabs.Content value="remote" class="mt-0 space-y-6">
					{@render tabDescription(m.settings_scope_remote_description())}
					<RemoteSettingsSection />
				</Tabs.Content>

				<Tabs.Content value="local" class="mt-0 space-y-6">
					{@render tabDescription(m.settings_scope_local_description())}
					<LocalSettingsSection />
				</Tabs.Content>

				<Tabs.Content value="shortcuts" class="mt-0 space-y-6">
					{@render tabDescription(m.settings_shortcuts_description())}
					<KeyboardShortcutsSection />
				</Tabs.Content>
			</div>
		</Tabs.Root>
	</Dialog.Content>
</Dialog.Root>
