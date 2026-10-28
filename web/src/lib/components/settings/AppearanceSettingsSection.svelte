<script lang="ts">
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { getLocalSettings } from '$lib/context';
	import {
		INLINE_IMAGE_THUMBNAIL_SIZE_VALUES,
		INLINE_MERMAID_THUMBNAIL_SIZE_VALUES,
		WORKSPACE_WINDOW_TITLEBAR_HEIGHT_DELTA_MAX_PX,
		WORKSPACE_WINDOW_TITLEBAR_HEIGHT_DELTA_MIN_PX,
		isChatMaxWidth,
		isInlineImageThumbnailSize,
		isInlineMermaidThumbnailSize,
		type ChatMaxWidth,
		type InlineImageThumbnailSize,
		type InlineMermaidThumbnailSize,
	} from '$lib/stores/local-settings.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import ThemeSettingsCard from './ThemeSettingsCard.svelte';
	import TypographySettings from './TypographySettings.svelte';
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
	const inlineImageThumbnailSizeLabels: Record<InlineImageThumbnailSize, () => string> = {
		small: m.settings_inline_image_thumbnail_size_small,
		medium: m.settings_inline_image_thumbnail_size_medium,
		large: m.settings_inline_image_thumbnail_size_large,
		full: m.settings_inline_image_thumbnail_size_full,
	};
	const inlineMermaidThumbnailSizeLabels: Record<InlineMermaidThumbnailSize, () => string> = {
		small: m.settings_inline_mermaid_thumbnail_size_small,
		medium: m.settings_inline_mermaid_thumbnail_size_medium,
		large: m.settings_inline_mermaid_thumbnail_size_large,
		full: m.settings_inline_mermaid_thumbnail_size_full,
	};

	function setChatMaxWidth(value: string) {
		if (isChatMaxWidth(value)) {
			ls.set('chatMaxWidth', value);
		}
	}

	function setInlineImageThumbnailSize(value: string): void {
		if (isInlineImageThumbnailSize(value)) ls.set('inlineImageThumbnailSize', value);
	}

	function setInlineMermaidThumbnailSize(value: string): void {
		if (isInlineMermaidThumbnailSize(value)) ls.set('inlineMermaidThumbnailSize', value);
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

<div class="space-y-4">
	<ThemeSettingsCard />

	<div>
		<div class="border-t border-border">
			<div class="flex flex-wrap items-center justify-between gap-2 py-3">
				<label class="text-sm font-medium" for="local-appearance">{m.settings_ui_style()}</label>
				<select
					id="local-appearance"
					class="select-native w-full sm:w-52"
					value={ls.terminalAppearance ? 'terminal' : 'default'}
					onchange={(event) =>
						ls.set('terminalAppearance', event.currentTarget.value === 'terminal')}
				>
					<option value="default">{m.settings_appearance_default()}</option>
					<option value="terminal">{m.settings_appearance_terminal()}</option>
				</select>
			</div>
			<TypographySettings />
			<h3 class="pt-4 pb-2 text-sm font-semibold">{m.settings_layout()}</h3>
			{@render settingRow(m.settings_highlight_active_window(), ls.highlightActiveWindow, () =>
				ls.toggle('highlightActiveWindow'),
			)}
			{@render settingRow(
				m.settings_fullscreen_covers_sidebar(),
				ls.fullscreenCoversSidebar,
				() => ls.toggle('fullscreenCoversSidebar'),
				{
					disabled: ls.chatListAutohide,
					description: ls.chatListAutohide
						? m.settings_fullscreen_covers_sidebar_autohide()
						: undefined,
				},
			)}
		</div>
		<div
			class="flex flex-col gap-2 border-t border-border py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
		>
			<div class="min-w-0">
				<label class="text-sm font-medium text-foreground" for="local-workspace-titlebar-size">
					{m.settings_workspace_titlebar_size()}
				</label>
				<p class="mt-0.5 text-xs text-muted-foreground">
					{m.settings_workspace_titlebar_size_description()}
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<input
					id="local-workspace-titlebar-size"
					type="range"
					min={WORKSPACE_WINDOW_TITLEBAR_HEIGHT_DELTA_MIN_PX}
					max={WORKSPACE_WINDOW_TITLEBAR_HEIGHT_DELTA_MAX_PX}
					step="1"
					value={ls.workspaceWindowTitlebarHeightDeltaPx}
					oninput={(event) =>
						ls.set('workspaceWindowTitlebarHeightDeltaPx', event.currentTarget.valueAsNumber)}
					class="min-w-0 flex-1 accent-primary sm:w-28 sm:flex-none"
				/>
				<output
					for="local-workspace-titlebar-size"
					class="w-12 text-right text-sm tabular-nums text-foreground"
				>
					{ls.workspaceWindowTitlebarHeightDeltaPx > 0
						? '+'
						: ''}{ls.workspaceWindowTitlebarHeightDeltaPx} px
				</output>
			</div>
		</div>
		<div class="flex items-center justify-between gap-4 border-t border-border py-2">
			<div class="text-sm font-medium text-foreground">{m.settings_chat_max_width()}</div>
			<select
				class="select-native"
				aria-label={m.settings_chat_max_width()}
				value={ls.chatMaxWidth}
				onchange={(event) => setChatMaxWidth((event.currentTarget as HTMLSelectElement).value)}
			>
				{#each chatMaxWidthOptions as option (option.value)}
					<option value={option.value}>{option.label()}</option>
				{/each}
			</select>
		</div>
		<div class="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
			<label class="min-w-0 text-sm font-medium text-foreground" for="local-inline-image-size">
				{m.settings_inline_image_thumbnail_size()}
			</label>
			<select
				id="local-inline-image-size"
				class="select-native w-full sm:w-auto sm:shrink-0"
				value={ls.inlineImageThumbnailSize}
				onchange={(event) => setInlineImageThumbnailSize(event.currentTarget.value)}
			>
				{#each INLINE_IMAGE_THUMBNAIL_SIZE_VALUES as size (size)}
					<option value={size}>{inlineImageThumbnailSizeLabels[size]()}</option>
				{/each}
			</select>
		</div>

		<div class="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
			<label class="min-w-0 text-sm font-medium text-foreground" for="local-inline-mermaid-size">
				{m.settings_inline_mermaid_thumbnail_size()}
			</label>
			<select
				id="local-inline-mermaid-size"
				class="select-native w-full sm:w-auto sm:shrink-0"
				value={ls.inlineMermaidThumbnailSize}
				onchange={(event) => setInlineMermaidThumbnailSize(event.currentTarget.value)}
			>
				{#each INLINE_MERMAID_THUMBNAIL_SIZE_VALUES as size (size)}
					<option value={size}>{inlineMermaidThumbnailSizeLabels[size]()}</option>
				{/each}
			</select>
		</div>

		{@render settingRow(
			m.settings_overlay_backdrop_effects(),
			ls.overlayBackdropEffects,
			() => ls.toggle('overlayBackdropEffects'),
			{ description: m.settings_overlay_backdrop_effects_description() },
		)}

		{@render settingRow(m.settings_chat_reduce_motion(), ls.reduceMotion, () =>
			ls.toggle('reduceMotion'),
		)}
		<section class="mt-4 border-t border-border pt-3" aria-label={m.settings_composer_status_bar()}>
			<h3 class="pb-2 text-sm font-semibold">{m.settings_composer_status_bar()}</h3>
			{@render settingRow(
				m.settings_composer_status_bar_git_projects(),
				ls.composerStatusBarGitProjects,
				() => ls.toggle('composerStatusBarGitProjects'),
			)}
			{@render settingRow(
				m.settings_composer_status_bar_non_git_projects(),
				ls.composerStatusBarNonGitProjects,
				() => ls.toggle('composerStatusBarNonGitProjects'),
			)}
			<h4 class="pt-3 pb-1 text-sm font-medium text-muted-foreground">
				{m.settings_composer_status_bar_items()}
			</h4>
			{@render settingRow(
				m.settings_composer_status_bar_project_path(),
				ls.composerStatusBarProjectPath,
				() => ls.toggle('composerStatusBarProjectPath'),
			)}
			{@render settingRow(
				m.settings_composer_status_bar_git_branch(),
				ls.composerStatusBarGitBranch,
				() => ls.toggle('composerStatusBarGitBranch'),
			)}
			{@render settingRow(m.settings_composer_status_bar_commit(), ls.composerStatusBarCommit, () =>
				ls.toggle('composerStatusBarCommit'),
			)}
		</section>
	</div>
</div>
