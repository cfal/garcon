<!-- Browser-stored settings. All values render immediately from persisted storage. -->
<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import {
		FILE_OPEN_PLACEMENT_VALUES,
		HIDEABLE_TOOL_GROUPS,
		isChatMaxWidth,
		isFileOpenPlacement,
		type ChatMaxWidth,
		type FileOpenPlacementPreference,
		type ThemeMode,
	} from '$lib/stores/local-settings.svelte.js';
	import { getLocalSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import DesktopLayoutOrderSetting from './DesktopLayoutOrderSetting.svelte';

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
	const hideableToolGroupLabels = {
		bash: m.settings_chat_hidden_tool_bash,
		exec: m.settings_chat_hidden_tool_exec,
		'file-reads': m.settings_chat_hidden_tool_file_reads,
		'file-changes': m.settings_chat_hidden_tool_file_changes,
		web: m.settings_chat_hidden_tool_web,
		tasks: m.settings_chat_hidden_tool_tasks,
		provider: m.settings_chat_hidden_tool_provider,
	} as const;
	type FilePlacementSettingKey =
		'textEditorOpenPlacement' | 'imageViewerOpenPlacement' | 'markdownViewerOpenPlacement';
	const fileOpenPlacementLabels: Record<FileOpenPlacementPreference, () => string> = {
		source: m.settings_file_open_placement_source,
		dialog: m.settings_file_open_placement_dialog,
		main: m.settings_file_open_placement_main,
		sidebar: m.settings_file_open_placement_sidebar,
	};

	function setTheme(mode: ThemeMode) {
		ls.set('theme', mode);
	}

	function setChatMaxWidth(value: string) {
		if (isChatMaxWidth(value)) {
			ls.set('chatMaxWidth', value);
		}
	}

	function setFileOpenPlacement(key: FilePlacementSettingKey, value: string): void {
		if (isFileOpenPlacement(value)) ls.set(key, value);
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

{#snippet fileOpenPlacementRow(
	label: string,
	key: FilePlacementSettingKey,
	value: FileOpenPlacementPreference,
)}
	<div class="flex items-center justify-between gap-4 py-2">
		<label class="min-w-0 text-sm font-medium text-foreground" for={`local-${key}`}>
			{label}
		</label>
		<select
			id={`local-${key}`}
			class="w-36 max-w-[50%] shrink-0 rounded-md border border-border bg-muted px-2 py-1 text-sm text-foreground"
			{value}
			onchange={(event) =>
				setFileOpenPlacement(key, (event.currentTarget as HTMLSelectElement).value)}
		>
			{#each FILE_OPEN_PLACEMENT_VALUES as placement (placement)}
				<option value={placement}>{fileOpenPlacementLabels[placement]()}</option>
			{/each}
		</select>
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
			<DesktopLayoutOrderSetting />
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
				m.settings_overlay_backdrop_effects(),
				ls.overlayBackdropEffects,
				() => ls.toggle('overlayBackdropEffects'),
				{ description: m.settings_overlay_backdrop_effects_description() },
			)}
			{@render settingRow(
				m.settings_workspace_hide_chat_list_for_git(),
				ls.hideChatListWhenGitInMain,
				() => ls.toggle('hideChatListWhenGitInMain'),
			)}
			{@render settingRow(m.settings_chat_auto_expand_tools(), ls.autoExpandTools, () =>
				ls.toggle('autoExpandTools'),
			)}
			{@render settingRow(m.settings_chat_show_thinking(), ls.showThinking, () =>
				ls.toggle('showThinking'),
			)}
			{@render settingRow(
				m.settings_chat_reduce_motion(),
				ls.reduceMotion,
				() => ls.toggle('reduceMotion'),
			)}
			<div class="py-2">
				<div class="text-sm font-medium text-foreground">{m.settings_chat_hidden_tools()}</div>
				<div class="mt-2 rounded-md border border-border bg-background/50 px-3">
					{#each HIDEABLE_TOOL_GROUPS as group (group.id)}
						{@render settingRow(
							hideableToolGroupLabels[group.id](),
							ls.areToolTypesHidden(group.toolTypes),
							() => ls.setToolTypesHidden(group.toolTypes, !ls.areToolTypesHidden(group.toolTypes)),
						)}
					{/each}
				</div>
			</div>
			{@render settingRow(m.settings_chat_show_quick_commit_tray(), ls.showQuickCommitTray, () =>
				ls.toggle('showQuickCommitTray'),
			)}
			{@render settingRow(m.settings_chat_auto_scroll_to_bottom(), ls.autoScrollToBottom, () =>
				ls.toggle('autoScrollToBottom'),
			)}
			{@render settingRow(m.settings_chat_send_by_shift_enter(), ls.sendByShiftEnter, () =>
				ls.toggle('sendByShiftEnter'),
			)}
			<div class="mt-2 border-t border-border pb-1 pt-2">
				<h3 class="py-2 text-sm font-medium text-foreground">{m.settings_file_opening()}</h3>
				{@render fileOpenPlacementRow(
					m.settings_text_editor_open_placement(),
					'textEditorOpenPlacement',
					ls.textEditorOpenPlacement,
				)}
				{@render fileOpenPlacementRow(
					m.settings_image_viewer_open_placement(),
					'imageViewerOpenPlacement',
					ls.imageViewerOpenPlacement,
				)}
				{@render fileOpenPlacementRow(
					m.settings_markdown_viewer_open_placement(),
					'markdownViewerOpenPlacement',
					ls.markdownViewerOpenPlacement,
				)}
			</div>
		</div>
	</div>
</div>
