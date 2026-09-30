<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as m from '$lib/paraglide/messages.js';
	import { untrack } from 'svelte';
	import { getAppShell, getRemoteSettings, getExecutors } from '$lib/context';
	import { isServerSettingsTab } from '$lib/stores/app-shell.svelte';
	import Network from '@lucide/svelte/icons/network';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Bot from '@lucide/svelte/icons/bot';
	import Bell from '@lucide/svelte/icons/bell';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Palette from '@lucide/svelte/icons/palette';
	import Keyboard from '@lucide/svelte/icons/keyboard';
	import ApiProvidersSection from './ApiProvidersSection.svelte';
	import AutomationSettingsSection from './AutomationSettingsSection.svelte';
	import ExecutorAgentSettings from './ExecutorAgentSettings.svelte';
	import SettingsExecutorSections from './SettingsExecutorSections.svelte';
	import GeneralSettingsSection from './GeneralSettingsSection.svelte';
	import GitHubCliSettingsCard from './GitHubCliSettingsCard.svelte';
	import NotificationsSettingsSection from './NotificationsSettingsSection.svelte';
	import ExecutorsSection from '../executors/ExecutorsSection.svelte';
	import LocalSettingsSection from './LocalSettingsSection.svelte';
	import KeyboardShortcutsSection from './KeyboardShortcutsSection.svelte';

	const appShell = getAppShell();
	const remoteSettings = getRemoteSettings();
	const executors = getExecutors();
	let scrollContainer = $state<HTMLDivElement | null>(null);
	// App tabs are stored in this browser; server tabs are shared by every client.
	const tabGroups = $derived([
		{
			id: 'app',
			label: m.settings_group_app(),
			tabs: [
				{ value: 'interface', label: m.settings_tab_interface(), icon: Palette },
				{ value: 'shortcuts', label: m.settings_tab_shortcuts(), icon: Keyboard },
			],
		},
		{
			id: 'server',
			label: m.settings_group_server(),
			tabs: [
				{ value: 'providers', label: m.settings_tab_providers(), icon: KeyRound },
				{ value: 'other-agents', label: m.settings_tab_other_agents(), icon: Bot },
				{ value: 'general', label: m.settings_tab_general(), icon: SlidersHorizontal },
				{ value: 'automation', label: m.settings_tab_automation(), icon: Sparkles },
				{ value: 'notifications', label: m.settings_tab_notifications(), icon: Bell },
				{ value: 'github', label: m.settings_tab_github(), icon: GitPullRequest },
				{ value: 'executors', label: m.settings_tab_executors(), icon: Network },
			],
		},
	]);

	// Browser-local tabs need no server data, so refresh once per open on the first server tab.
	let serverDataRefreshed = false;
	$effect(() => {
		if (!appShell.showSettings || serverDataRefreshed) return;
		if (!isServerSettingsTab(appShell.settingsTab)) return;
		serverDataRefreshed = true;
		untrack(() => {
			void remoteSettings.refreshInBackground();
			void executors.refresh();
		});
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
				{#each tabGroups as group, index (group.id)}
					{#if index > 0}
						<div aria-hidden="true" class="mx-1 my-1 border-t border-border sm:hidden"></div>
					{/if}
					<div
						id="settings-tab-group-{group.id}"
						aria-hidden="true"
						class="hidden px-2 pb-1 text-xs font-medium text-muted-foreground sm:block {index > 0
							? 'pt-3'
							: ''}"
					>
						{group.label}
					</div>
					{#each group.tabs as tab (tab.value)}
						<Tabs.Trigger
							value={tab.value}
							aria-label={tab.label}
							aria-describedby="settings-tab-group-{group.id}"
							title={tab.label}
							class="h-auto min-h-10 flex-none px-2 py-2 sm:justify-start sm:gap-2 sm:whitespace-normal sm:text-left"
						>
							<tab.icon class="size-4" />
							<span class="hidden sm:inline">{tab.label}</span>
						</Tabs.Trigger>
					{/each}
				{/each}
			</Tabs.List>

			<div class="min-w-0 flex-1 min-h-0 overflow-y-auto p-3 sm:p-6" bind:this={scrollContainer}>
				<Tabs.Content value="interface" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'interface'}
						<p class="text-sm text-muted-foreground">{m.settings_scope_local_description()}</p>
						<LocalSettingsSection />
					{/if}
				</Tabs.Content>

				<Tabs.Content value="shortcuts" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'shortcuts'}
						<KeyboardShortcutsSection />
					{/if}
				</Tabs.Content>

				<Tabs.Content value="providers" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'providers'}
						<ApiProvidersSection />
					{/if}
				</Tabs.Content>

				<Tabs.Content value="other-agents" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'other-agents'}
						<p class="text-sm text-muted-foreground">{m.settings_other_agents_description()}</p>
						<SettingsExecutorSections>
							{#snippet children(executorId)}<ExecutorAgentSettings
									{executorId}
									section="other-agents"
								/>{/snippet}
						</SettingsExecutorSections>
					{/if}
				</Tabs.Content>

				<Tabs.Content value="general" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'general'}
						<GeneralSettingsSection />
					{/if}
				</Tabs.Content>

				<Tabs.Content value="automation" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'automation'}
						<AutomationSettingsSection />
					{/if}
				</Tabs.Content>

				<Tabs.Content value="notifications" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'notifications'}
						<NotificationsSettingsSection />
					{/if}
				</Tabs.Content>

				<Tabs.Content value="github" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'github'}
						<SettingsExecutorSections>
							{#snippet children(executorId)}<GitHubCliSettingsCard {executorId} />{/snippet}
						</SettingsExecutorSections>
					{/if}
				</Tabs.Content>

				<Tabs.Content value="executors" class="mt-0 space-y-6">
					{#if appShell.settingsTab === 'executors'}
						<ExecutorsSection />
					{/if}
				</Tabs.Content>
			</div>
		</Tabs.Root>
	</Dialog.Content>
</Dialog.Root>
