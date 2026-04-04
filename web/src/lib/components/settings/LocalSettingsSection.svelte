<!-- Browser-stored settings. All values render immediately from localStorage. -->
<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import type { ThemeMode } from '$lib/stores/local-settings.svelte.js';
	import { getLocalSettings } from '$lib/context';
	import type { SidebarSearchBarPosition } from '$lib/types/session.js';
	import * as m from '$lib/paraglide/messages.js';

	const ls = getLocalSettings();

	function setTheme(mode: ThemeMode) {
		ls.set('theme', mode);
	}

	function setSearchBarPosition(position: SidebarSearchBarPosition) {
		ls.set('searchBarPosition', position);
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

<div class="space-y-3">
	<div class="bg-muted/50 border border-border rounded-lg">
		<!-- Theme -->
		<div class="flex items-center justify-between px-4 py-3">
			<div class="text-sm font-medium text-foreground">{m.settings_appearance_settings_dark_mode_label()}</div>
			<div class="flex gap-1 bg-muted rounded-lg p-1">
				<Button
					variant={ls.theme === 'light' ? 'default' : 'ghost'}
					size="icon-sm"
					onclick={() => setTheme('light')}
					title="Light"
				>
					<SunIcon class="size-3.5" />
				</Button>
				<Button
					variant={ls.theme === 'dark' ? 'default' : 'ghost'}
					size="icon-sm"
					onclick={() => setTheme('dark')}
					title="Dark"
				>
					<MoonIcon class="size-3.5" />
				</Button>
				<Button
					variant={ls.theme === 'system' ? 'default' : 'ghost'}
					size="icon-sm"
					onclick={() => setTheme('system')}
					title="System"
				>
					<MonitorIcon class="size-3.5" />
				</Button>
			</div>
		</div>

		<div class="px-4">
			<div class="flex items-center justify-between py-2">
				<div class="text-sm font-medium text-foreground">
					{m.settings_display_sidebar_controls_position()}
				</div>
				<select
					class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground"
					aria-label={m.settings_display_sidebar_controls_position()}
					value={ls.searchBarPosition}
					onchange={(event) =>
						setSearchBarPosition((event.currentTarget as HTMLSelectElement).value as SidebarSearchBarPosition)}
				>
					<option value="top">{m.sidebar_chats_pinned_insert_top()}</option>
					<option value="bottom">{m.sidebar_chats_pinned_insert_bottom()}</option>
				</select>
			</div>
			{@render settingRow(
				m.settings_accessibility_colorblind_mode(),
				ls.colorblindMode,
				() => ls.toggle('colorblindMode')
			)}
			{@render settingRow(
				m.settings_display_show_fullscreen_button(),
				ls.alwaysFullscreenOnGitPanel,
				() => ls.toggle('alwaysFullscreenOnGitPanel')
			)}
			{@render settingRow(
				m.settings_chat_auto_expand_tools(),
				ls.autoExpandTools,
				() => ls.toggle('autoExpandTools')
			)}
			{@render settingRow(
				m.settings_chat_show_thinking(),
				ls.showThinking,
				() => ls.toggle('showThinking')
			)}
			{@render settingRow(
				m.settings_chat_auto_scroll_to_bottom(),
				ls.autoScrollToBottom,
				() => ls.toggle('autoScrollToBottom')
			)}
			{@render settingRow(
				m.settings_chat_send_by_shift_enter(),
				ls.sendByShiftEnter,
				() => ls.toggle('sendByShiftEnter')
			)}
			{@render settingRow(
				m.settings_chat_always_show_chat_header(),
				ls.showChatHeader,
				() => ls.toggle('showChatHeader')
			)}
		</div>
	</div>
</div>
