<!-- Browser-stored settings. All values render immediately from persisted storage. -->
<script lang="ts">
	import { untrack } from 'svelte';
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
	import type { ChatListDock } from '$lib/layout/desktop-layout.js';
	import {
		SNIPPET_TRIGGER_MAX_LENGTH,
		snippetTriggerValidationError,
	} from '$lib/chat/composer/snippet-trigger.js';
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
		'new-pane': m.settings_file_open_placement_new_pane,
		dialog: m.settings_file_open_placement_dialog,
	};
	const chatListDockLabels: Record<ChatListDock, () => string> = {
		left: m.settings_chat_list_dock_left,
		right: m.settings_chat_list_dock_right,
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

	function setChatListDock(value: string): void {
		if (value === 'left' || value === 'right') ls.set('chatListDock', value);
	}

	let snippetTriggerDraft = $state(ls.snippetTrigger);
	let snippetTriggerError = $state<string | null>(null);

	// Keeps the draft aligned with externally applied values (other tabs).
	$effect(() => {
		const stored = ls.snippetTrigger;
		untrack(() => {
			if (stored !== snippetTriggerDraft && snippetTriggerError === null) {
				snippetTriggerDraft = stored;
			}
		});
	});

	function commitSnippetTrigger(): void {
		const error = snippetTriggerValidationError(snippetTriggerDraft);
		if (error === null) {
			ls.set('snippetTrigger', snippetTriggerDraft);
			snippetTriggerDraft = ls.snippetTrigger;
			snippetTriggerError = null;
			return;
		}
		snippetTriggerError =
			error === 'format'
				? m.settings_snippet_trigger_error_format()
				: m.settings_snippet_trigger_error_charset();
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
			class="w-36 max-w-[50%] shrink-0 rounded-md border border-border bg-muted px-2 py-1 text-base text-foreground sm:pointer-fine:text-sm"
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
			<div class="flex items-center justify-between gap-4 border-t border-border py-2">
				<label class="min-w-0 text-sm font-medium text-foreground" for="local-chat-list-dock">
					{m.settings_chat_list_dock()}
				</label>
				<select
					id="local-chat-list-dock"
					class="w-36 max-w-[50%] shrink-0 rounded-md border border-border bg-muted px-2 py-1 text-base text-foreground sm:pointer-fine:text-sm"
					value={ls.chatListDock}
					onchange={(event) =>
						setChatListDock((event.currentTarget as HTMLSelectElement).value)}
				>
					{#each ['left', 'right'] as const as dock (dock)}
						<option value={dock}>{chatListDockLabels[dock]()}</option>
					{/each}
				</select>
			</div>
			<div class="flex items-center justify-between gap-4 py-2">
				<div class="text-sm font-medium text-foreground">{m.settings_chat_max_width()}</div>
				<select
					class="rounded-md border border-border bg-muted px-2 py-1 text-base text-foreground sm:pointer-fine:text-sm"
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
			{@render settingRow(
				m.settings_chat_always_expand_cli_messages(),
				ls.alwaysExpandCliMessages,
				() => ls.toggle('alwaysExpandCliMessages'),
				{ description: m.settings_chat_always_expand_cli_messages_description() },
			)}
			{@render settingRow(m.settings_chat_show_thinking(), ls.showThinking, () =>
				ls.toggle('showThinking'),
			)}
			{@render settingRow(
				m.settings_chat_allow_direct_chats(),
				ls.allowDirectChats,
				() => ls.toggle('allowDirectChats'),
				{ description: m.settings_chat_allow_direct_chats_description() },
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
			<div class="flex items-center justify-between gap-4 py-2">
				<div class="min-w-0">
					<label class="text-sm font-medium text-foreground" for="local-snippet-trigger">
						{m.settings_snippet_trigger_label()}
					</label>
					<p class="mt-0.5 text-xs text-muted-foreground">
						{m.settings_snippet_trigger_description()}
					</p>
					{#if snippetTriggerError}
						<p id="local-snippet-trigger-error" class="mt-0.5 text-xs text-destructive">
							{snippetTriggerError}
						</p>
					{/if}
				</div>
				<input
					id="local-snippet-trigger"
					type="text"
					maxlength={SNIPPET_TRIGGER_MAX_LENGTH}
					bind:value={snippetTriggerDraft}
					aria-invalid={snippetTriggerError !== null}
					aria-describedby={snippetTriggerError ? 'local-snippet-trigger-error' : undefined}
					autocapitalize="off"
					spellcheck="false"
					oninput={() => (snippetTriggerError = null)}
					onblur={commitSnippetTrigger}
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							commitSnippetTrigger();
						}
					}}
					class="w-24 shrink-0 rounded-md border border-border bg-muted px-2 py-1 text-center font-mono text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
				/>
			</div>
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
