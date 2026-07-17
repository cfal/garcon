<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Play from '@lucide/svelte/icons/play';
	import SettingsModelSelector from '$lib/components/model-selector/SettingsModelSelector.svelte';
	import type { ModelSelectorMode } from '$lib/components/model-selector/model-selector-types';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { getModelCatalog, getRemoteSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import {
		RemoteGenerationSettingsCardState,
		type GenerationSettingsKey,
	} from './remote-generation-settings-card-state.svelte';

	interface Props {
		settingsKey: GenerationSettingsKey;
		enabledLabel?: string;
		modelLabel: string;
		showDirectoryPrefix?: boolean;
		showPrompt?: boolean;
	}

	let {
		settingsKey,
		enabledLabel,
		modelLabel,
		showDirectoryPrefix = false,
		showPrompt = false,
	}: Props = $props();

	const remoteSettings = getRemoteSettings();
	const modelCatalog = getModelCatalog();
	const selectorMode: ModelSelectorMode = {
		agent: 'select',
		source: 'select',
		surface: 'settings',
		effort: 'select',
	};
	const cardState = new RemoteGenerationSettingsCardState({
		remoteSettings,
		modelCatalog,
		get settingsKey() {
			return settingsKey;
		},
		get enabledLabel() {
			return enabledLabel;
		},
		get showPrompt() {
			return showPrompt;
		},
	});

	$effect(() => {
		cardState.syncPromptDraft();
	});
</script>

<div class="bg-muted/50 border border-border rounded-lg px-4">
	{#if cardState.saveError}
		<div
			class="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
		>
			{cardState.saveError}
		</div>
	{/if}

	{#if cardState.hasEnabledSwitch && enabledLabel}
		<div class="flex items-center justify-between py-2">
			<div class="text-sm font-medium text-foreground">{enabledLabel}</div>
			<Switch
				checked={cardState.enabled}
				onCheckedChange={async (next) => {
					await cardState.persistSettings({ enabled: Boolean(next) });
				}}
				aria-label={enabledLabel}
			/>
		</div>
	{/if}

	{#if cardState.enabled}
		<div class="flex items-start justify-between gap-3 pb-1 pt-2">
			<div class="pt-1.5 text-sm font-medium text-foreground">{modelLabel}</div>
			<div class="flex min-w-0 flex-col items-end">
				<SettingsModelSelector
					value={cardState.selectorValue}
					mode={selectorMode}
					onChange={(next) => cardState.persistSelection(next)}
					align="end"
					side="bottom"
					disabled={cardState.isSaving}
				/>
				<Button
					variant="outline"
					size="sm"
					class="mt-1.5 text-base sm:text-sm"
					disabled={cardState.isSaving || cardState.testing}
					onclick={() => cardState.runGenerationModelTest()}
					aria-busy={cardState.testing}
					aria-label={m.settings_generation_model_test()}
				>
					{#if cardState.testing}
						<LoaderCircle class="animate-spin" />
						{m.settings_generation_model_test_running()}
					{:else}
						<Play />
						{m.settings_generation_model_test()}
					{/if}
				</Button>
				<div
					class="mt-1 min-h-4 max-w-sm text-right text-xs leading-4"
					role="status"
					aria-live="polite"
				>
					{#if cardState.visibleTestResult}
						<span class="block text-muted-foreground">
							{m.settings_generation_model_test_response({
								duration: cardState.formatDuration(cardState.visibleTestResult.durationMs),
							})}
						</span>
					{:else if cardState.visibleTestError}
						<span class="block text-destructive">{cardState.visibleTestError}</span>
					{/if}
				</div>
			</div>
		</div>

		{#if showPrompt}
			<div class="space-y-1.5 py-2">
				<div class="text-sm font-medium text-foreground">
					{m.settings_commit_generation_prompt()}
				</div>
				<textarea
					value={cardState.promptDraft}
					oninput={(event) => {
						cardState.promptDraft = event.currentTarget.value;
					}}
					onblur={() => cardState.persistPromptDraft()}
					aria-label={m.settings_commit_generation_prompt()}
					placeholder={m.settings_commit_prompt_placeholder({
						files: '{{files}}',
						diff: '{{diff}}',
					})}
					class="w-full text-sm p-2.5 bg-muted/30 border border-border rounded-md resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent text-foreground placeholder:text-muted-foreground/60"
					rows="8"></textarea>
				<div class="rounded-md border border-border bg-muted/20 px-3 py-2">
					<div class="text-xs font-medium text-foreground">
						{m.settings_commit_prompt_legend_title()}
					</div>
					<div class="mt-1 space-y-1 text-xs text-muted-foreground">
						<div>
							<code class="font-mono text-foreground">{'{{files}}'}</code>
							{m.settings_commit_prompt_legend_files()}
						</div>
						<div>
							<code class="font-mono text-foreground">{'{{diff}}'}</code>
							{m.settings_commit_prompt_legend_diff()}
						</div>
					</div>
				</div>
				{#if !cardState.isDefaultPrompt}
					<div class="flex justify-end">
						<Button
							variant="outline"
							size="sm"
							onclick={() => cardState.restoreDefaultPrompt()}
						>
							{m.settings_commit_restore_default_prompt()}
						</Button>
					</div>
				{/if}
			</div>
		{/if}

		{#if showDirectoryPrefix}
			<div class="flex items-center justify-between py-2">
				<div class="text-sm font-medium text-foreground">
					{m.settings_commit_add_common_directory_prefix()}
				</div>
				<Switch
					checked={cardState.directoryPrefixEnabled}
					onCheckedChange={async (next) => {
						await cardState.persistSettings({ useCommonDirPrefix: Boolean(next) });
					}}
					aria-label={m.settings_commit_add_common_directory_prefix_aria()}
				/>
			</div>
		{/if}
	{/if}
</div>
