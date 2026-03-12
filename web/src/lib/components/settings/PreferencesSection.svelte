<!-- Preferences settings section. Groups display and chat settings
     into compact cards with Switch toggles. -->
<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import type { ThemeMode } from '$lib/stores/preferences.svelte.js';
	import type { SessionProvider } from '$lib/types/app';
	import { onMount } from 'svelte';
	import { getModelCatalog, getPreferences } from '$lib/context';
	import { getSettings, updateSettings } from '$lib/api/settings.js';
	import * as m from '$lib/paraglide/messages.js';

	const preferences = getPreferences();
	const modelCatalog = getModelCatalog();

	function setTheme(mode: ThemeMode) {
		preferences.setPreference('theme', mode);
	}

	function togglePref(
		key: 'colorblindMode' | 'autoExpandTools' | 'showThinking' | 'autoScrollToBottom' | 'sendByShiftEnter' | 'showChatHeader' | 'alwaysFullscreenOnGitPanel'
	) {
		preferences.setPreference(key, !preferences[key]);
	}

	type PinnedInsertPosition = 'top' | 'bottom';
	let pinnedInsertPosition = $state<PinnedInsertPosition>('top');

	// Chat title auto-generation settings (server-persisted).
	let titleEnabled = $state(false);
	let titleProvider = $state<SessionProvider>('claude');
	let titleModel = $state('');

	// Shared model catalog for title provider selection.
	let availableTitleModels = $derived(modelCatalog.getModels(titleProvider));
	let availableProviders = $derived(modelCatalog.getProviders());

	onMount(async () => {
		const settings = await getSettings();
		const ui = (settings.ui ?? {}) as Record<string, unknown>;
		const uiEffective = (settings.uiEffective ?? {}) as Record<string, unknown>;
		const raw = ui.pinnedInsertPosition;
		pinnedInsertPosition = raw === 'bottom' ? 'bottom' : 'top';

		// Hydrate chat title settings.
		const chatTitleEffective = (uiEffective.chatTitle ?? ui.chatTitle ?? {}) as Record<string, unknown>;
		titleEnabled = chatTitleEffective.enabled !== false;
		titleProvider = (['claude', 'codex', 'opencode'].includes(chatTitleEffective.provider as string)
			? chatTitleEffective.provider as SessionProvider
			: 'claude');
		titleModel = typeof chatTitleEffective.model === 'string' ? chatTitleEffective.model : '';

		await modelCatalog.refreshIfStale();
		const titleProviderModels = modelCatalog.getModels(titleProvider);
		if (!titleModel && titleProviderModels.length > 0) {
			titleModel = titleProviderModels[0].value;
		}
	});

	function providerLabel(provider: SessionProvider): string {
		if (provider === 'claude') return m.provider_claude();
		if (provider === 'codex') return m.provider_codex();
		return m.provider_opencode();
	}

	async function onPinnedInsertPositionChange(next: PinnedInsertPosition) {
		pinnedInsertPosition = next;
		await updateSettings({ ui: { pinnedInsertPosition: next } });
	}

	async function persistChatTitleSettings() {
		await updateSettings({
			ui: {
				chatTitle: {
					enabled: titleEnabled,
					provider: titleProvider,
					model: titleModel,
				},
			},
		});
	}

</script>

{#snippet settingRow(label: string, checked: boolean, onToggle: () => void)}
	<div class="flex items-center justify-between py-2">
		<div class="text-sm font-medium text-foreground">{label}</div>
		<Switch
			{checked}
			onCheckedChange={() => onToggle()}
			aria-label={label}
		/>
	</div>
{/snippet}

<!-- Display + Chat -->
<section data-section="display" class="space-y-3">
	<div class="bg-muted/50 border border-border rounded-lg">
		<!-- Theme -->
		<div class="flex items-center justify-between px-4 py-3">
			<div class="text-sm font-medium text-foreground">{m.settings_appearance_settings_dark_mode_label()}</div>
			<div class="flex gap-1 bg-muted rounded-lg p-1">
				<Button
					variant={preferences.theme === 'light' ? 'default' : 'ghost'}
					size="icon-sm"
					onclick={() => setTheme('light')}
					title="Light"
				>
					<SunIcon class="size-3.5" />
				</Button>
				<Button
					variant={preferences.theme === 'dark' ? 'default' : 'ghost'}
					size="icon-sm"
					onclick={() => setTheme('dark')}
					title="Dark"
				>
					<MoonIcon class="size-3.5" />
				</Button>
				<Button
					variant={preferences.theme === 'system' ? 'default' : 'ghost'}
					size="icon-sm"
					onclick={() => setTheme('system')}
					title="System"
				>
					<MonitorIcon class="size-3.5" />
				</Button>
			</div>
		</div>

		<div class="px-4">
			{@render settingRow(
				m.settings_accessibility_colorblind_mode(),
				preferences.colorblindMode,
				() => togglePref('colorblindMode')
			)}
			{@render settingRow(
				m.settings_display_show_fullscreen_button(),
				preferences.alwaysFullscreenOnGitPanel,
				() => togglePref('alwaysFullscreenOnGitPanel')
			)}
		</div>

		<div class="flex items-center justify-between px-4 py-2" data-section="chat">
			<div class="text-sm font-medium text-foreground">{m.sidebar_chats_pinned_insert_position()}</div>
			<select
				class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground"
				value={pinnedInsertPosition}
				onchange={(e) => onPinnedInsertPositionChange((e.currentTarget as HTMLSelectElement).value as PinnedInsertPosition)}
			>
				<option value="top">{m.sidebar_chats_pinned_insert_top()}</option>
				<option value="bottom">{m.sidebar_chats_pinned_insert_bottom()}</option>
			</select>
		</div>
		<div class="px-4">
			{@render settingRow(
				m.settings_chat_auto_expand_tools(),
				preferences.autoExpandTools,
				() => togglePref('autoExpandTools')
			)}
			{@render settingRow(
				m.settings_chat_show_thinking(),
				preferences.showThinking,
				() => togglePref('showThinking')
			)}
			{@render settingRow(
				m.settings_chat_auto_scroll_to_bottom(),
				preferences.autoScrollToBottom,
				() => togglePref('autoScrollToBottom')
			)}
			{@render settingRow(
				m.settings_chat_send_by_shift_enter(),
				preferences.sendByShiftEnter,
				() => togglePref('sendByShiftEnter')
			)}
			{@render settingRow(
				m.settings_chat_always_show_chat_header(),
				preferences.showChatHeader,
				() => togglePref('showChatHeader')
			)}
		</div>
	</div>

	<div class="bg-muted/50 border border-border rounded-lg px-4">
		<div class="flex items-center justify-between py-2">
			<div class="text-sm font-medium text-foreground">{m.settings_chat_generate_titles()}</div>
			<Switch
				checked={titleEnabled}
				onCheckedChange={async (next) => {
					titleEnabled = Boolean(next);
					await persistChatTitleSettings();
				}}
				aria-label={m.settings_chat_generate_titles()}
			/>
		</div>

		{#if titleEnabled}
			<div class="flex items-center justify-between py-2">
				<div class="text-sm font-medium text-foreground">{m.settings_chat_title_provider()}</div>
				<select
					class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground"
					value={titleProvider}
					onchange={async (e) => {
						titleProvider = (e.currentTarget as HTMLSelectElement).value as SessionProvider;
						const models = modelCatalog.getModels(titleProvider);
						if (!models.some((opt) => opt.value === titleModel)) {
							titleModel = models[0]?.value ?? '';
						}
						await persistChatTitleSettings();
					}}
				>
					{#each availableProviders as provider (provider)}
						<option value={provider}>{providerLabel(provider)}</option>
					{/each}
				</select>
			</div>

			<div class="flex items-center justify-between py-2">
				<div class="text-sm font-medium text-foreground">{m.settings_chat_title_model()}</div>
				<select
					class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground"
					value={titleModel}
					onchange={async (e) => {
						titleModel = (e.currentTarget as HTMLSelectElement).value;
						await persistChatTitleSettings();
					}}
				>
					{#each availableTitleModels as opt (opt.value)}
						<option value={opt.value}>{opt.label}</option>
					{/each}
				</select>
			</div>
		{/if}
	</div>

</section>
