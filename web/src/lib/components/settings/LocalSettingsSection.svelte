<!-- Browser-stored settings. All values render immediately from persisted storage. -->
<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import {
		isChatMaxWidth,
		type ChatMaxWidth,
		type ThemeMode,
	} from '$lib/stores/local-settings.svelte.js';
	import { getLocalSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	interface SettingRowOptions {
		disabled?: boolean;
		description?: string;
	}

	const ls = getLocalSettings();
	const chatMaxWidthOptions: Array<{ value: ChatMaxWidth; label: () => string }> = [
		{ value: 'none', label: m.settings_chat_max_width_none },
		{ value: 'large', label: m.settings_chat_max_width_large },
		{ value: 'medium', label: m.settings_chat_max_width_medium },
		{ value: 'small', label: m.settings_chat_max_width_small },
	];

	function setTheme(mode: ThemeMode) {
		ls.set('theme', mode);
	}

	function setChatMaxWidth(value: string) {
		if (isChatMaxWidth(value)) {
			ls.set('chatMaxWidth', value);
		}
	}
</script>

{#snippet settingRow(
	label: string,
	checked: boolean,
	onToggle: () => void,
	options: SettingRowOptions = {},
)}
	<div class="flex items-center justify-between gap-4 py-2">
		<div class="min-w-0">
			<div class="text-sm font-medium text-foreground">{label}</div>
			{#if options.description}
				<div class="mt-0.5 text-xs text-muted-foreground">{options.description}</div>
			{/if}
		</div>
		<Switch
			{checked}
			disabled={options.disabled}
			onCheckedChange={() => {
				if (!options.disabled) onToggle();
			}}
			aria-label={label}
		/>
	</div>
{/snippet}

<div class="space-y-3">
	<div class="bg-muted/50 border border-border rounded-lg">
		<!-- Theme -->
		<div class="flex items-center justify-between px-4 py-3">
			<div class="text-sm font-medium text-foreground">
				{m.settings_appearance_settings_dark_mode_label()}
			</div>
			<div class="flex gap-1 bg-muted rounded-lg p-1">
				<Button
					variant={ls.theme === 'light' ? 'default' : 'ghost'}
					size="icon-sm"
					onclick={() => setTheme('light')}
					title={m.settings_theme_light()}
				>
					<SunIcon class="size-3.5" />
				</Button>
				<Button
					variant={ls.theme === 'dark' ? 'default' : 'ghost'}
					size="icon-sm"
					onclick={() => setTheme('dark')}
					title={m.settings_theme_dark()}
				>
					<MoonIcon class="size-3.5" />
				</Button>
				<Button
					variant={ls.theme === 'system' ? 'default' : 'ghost'}
					size="icon-sm"
					onclick={() => setTheme('system')}
					title={m.settings_theme_system()}
				>
					<MonitorIcon class="size-3.5" />
				</Button>
			</div>
		</div>

		<div class="px-4">
			<div class="flex items-center justify-between gap-4 py-2">
				<div class="text-sm font-medium text-foreground">{m.settings_chat_max_width()}</div>
				<select
					class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground"
					aria-label={m.settings_chat_max_width()}
					value={ls.chatMaxWidth}
					onchange={(event) => setChatMaxWidth((event.currentTarget as HTMLSelectElement).value)}
				>
					{#each chatMaxWidthOptions as option (option.value)}
						<option value={option.value}>{option.label()}</option>
					{/each}
				</select>
			</div>
			{@render settingRow(m.settings_accessibility_colorblind_mode(), ls.colorblindMode, () =>
				ls.toggle('colorblindMode'),
			)}
			{@render settingRow(
				m.settings_display_show_fullscreen_button(),
				ls.alwaysFullscreenOnGitPanel,
				() => ls.toggle('alwaysFullscreenOnGitPanel'),
			)}
			{@render settingRow(m.settings_sidebar_group_by_project(), ls.sidebarGroupByProject, () =>
				ls.toggle('sidebarGroupByProject'),
			)}
			{@render settingRow(
				m.settings_sidebar_group_nested_project_paths(),
				ls.sidebarGroupNestedProjectPaths,
				() => ls.toggle('sidebarGroupNestedProjectPaths'),
				{
					disabled: !ls.sidebarGroupByProject,
					description: m.settings_sidebar_group_nested_project_paths_description(),
				},
			)}
			{@render settingRow(m.settings_sidebar_compact_chat_items(), ls.sidebarCompactChatItems, () =>
				ls.toggle('sidebarCompactChatItems'),
			)}
			{@render settingRow(m.settings_chat_auto_expand_tools(), ls.autoExpandTools, () =>
				ls.toggle('autoExpandTools'),
			)}
			{@render settingRow(m.settings_chat_show_thinking(), ls.showThinking, () =>
				ls.toggle('showThinking'),
			)}
			{@render settingRow(m.settings_chat_show_quick_commit_tray(), ls.showQuickCommitTray, () =>
				ls.toggle('showQuickCommitTray'),
			)}
			{@render settingRow(m.settings_chat_auto_scroll_to_bottom(), ls.autoScrollToBottom, () =>
				ls.toggle('autoScrollToBottom'),
			)}
			{@render settingRow(m.settings_chat_send_by_shift_enter(), ls.sendByShiftEnter, () =>
				ls.toggle('sendByShiftEnter'),
			)}
		</div>
	</div>
</div>
