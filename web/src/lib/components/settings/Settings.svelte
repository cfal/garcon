<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as m from '$lib/paraglide/messages.js';
	import { getAppShell, getRemoteSettings, getExecutors } from '$lib/context';
	import Network from '@lucide/svelte/icons/network';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Bot from '@lucide/svelte/icons/bot';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import ApiProvidersSection from './ApiProvidersSection.svelte';
	import ExecutorAgentSettings from './ExecutorAgentSettings.svelte';
	import SettingsExecutorSections from './SettingsExecutorSections.svelte';
	import GitHubCliSettingsCard from './GitHubCliSettingsCard.svelte';
	import RemoteSettingsSection from './RemoteSettingsSection.svelte';
	import ExecutorsSection from '../executors/ExecutorsSection.svelte';

	const appShell = getAppShell();
	const remoteSettings = getRemoteSettings();
	const executors = getExecutors();
	let scrollContainer = $state<HTMLDivElement | null>(null);
	const tabs = $derived([
		{ value: 'executors', label: m.settings_tab_executors(), icon: Network },
		{ value: 'providers', label: m.settings_tab_providers(), icon: KeyRound },
		{ value: 'other-agents', label: m.settings_tab_other_agents(), icon: Bot },
		{ value: 'github', label: m.settings_tab_github(), icon: GitPullRequest },
		{ value: 'general', label: m.settings_tab_general(), icon: SlidersHorizontal },
	]);

	$effect(() => {
		if (!appShell.showSettings) return;
		void remoteSettings.refreshInBackground();
		void executors.refresh();
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

<Dialog.Root open={appShell.showSettings} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="safe-viewport-dialog h-[85dvh] max-h-[50rem] max-w-[calc(100%-1rem)] sm:max-w-5xl flex flex-col gap-0 p-0 overflow-hidden"
		showCloseButton={true}
	>
		<Dialog.Header class="px-6 py-3 border-b border-border">
			<Dialog.Title class="text-lg font-semibold">{m.settings_title()}</Dialog.Title>
			<Dialog.Description class="sr-only">{m.settings_title()}</Dialog.Description>
		</Dialog.Header>

		<Tabs.Root
			value={appShell.settingsTab}
			onValueChange={handleTabChange}
			orientation="vertical"
			class="min-h-0 flex-1 flex-row gap-0"
		>
			<Tabs.List
				aria-label={m.settings_title()}
				class="h-full w-14 shrink-0 flex-col items-stretch justify-start gap-1 overflow-y-auto rounded-none border-r border-border bg-muted/30 p-1.5 sm:w-48 sm:p-3"
			>
				{#each tabs as tab (tab.value)}
					<Tabs.Trigger
						value={tab.value}
						aria-label={tab.label}
						title={tab.label}
						class="h-auto min-h-10 flex-none px-2 py-2 sm:justify-start sm:gap-2 sm:whitespace-normal sm:text-left"
					>
						<tab.icon class="size-4" />
						<span class="hidden sm:inline">{tab.label}</span>
					</Tabs.Trigger>
				{/each}
			</Tabs.List>

			<div class="min-w-0 flex-1 min-h-0 overflow-y-auto p-3 sm:p-6" bind:this={scrollContainer}>
				<Tabs.Content value="executors" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'executors'}
						<h2 class="text-base font-semibold">{m.settings_tab_executors()}</h2>
						<ExecutorsSection />
					{/if}
				</Tabs.Content>

				<Tabs.Content value="providers" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'providers'}
						<ApiProvidersSection />
					{/if}
				</Tabs.Content>

				<Tabs.Content value="other-agents" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'other-agents'}
						<h2 class="text-base font-semibold">{m.settings_tab_other_agents()}</h2>
						<p class="text-sm text-muted-foreground">{m.settings_other_agents_description()}</p>
						<SettingsExecutorSections>
							{#snippet children(executorId)}<ExecutorAgentSettings
									{executorId}
									section="other-agents"
								/>{/snippet}
						</SettingsExecutorSections>
					{/if}
				</Tabs.Content>

				<Tabs.Content value="github" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'github'}
						<h2 class="text-base font-semibold">{m.settings_tab_github()}</h2>
						<SettingsExecutorSections>
							{#snippet children(executorId)}<GitHubCliSettingsCard {executorId} />{/snippet}
						</SettingsExecutorSections>
					{/if}
				</Tabs.Content>

				<Tabs.Content value="general" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'general'}
						<h2 class="text-base font-semibold">{m.settings_tab_general()}</h2>
						<RemoteSettingsSection />
					{/if}
				</Tabs.Content>
			</div>
		</Tabs.Root>
	</Dialog.Content>
</Dialog.Root>
