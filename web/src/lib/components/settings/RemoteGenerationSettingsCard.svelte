<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Play from '@lucide/svelte/icons/play';
	import SettingsModelSelector from '$lib/components/model-selector/SettingsModelSelector.svelte';
	import type { ModelSelectorMode } from '$lib/components/model-selector/model-selector-types';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { getModelCatalog, getRemoteSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import {
		DEFAULT_COMMIT_MESSAGE_PROMPT,
		DEFAULT_PROMPT_REFINEMENT_PROMPT,
	} from '$shared/generation-prompts';
	import { parseAgentSwitchContextWindowTokens } from '$shared/handoff-sizing';
	import GenerationPromptDialog, {
		type GenerationPromptKind,
	} from './GenerationPromptDialog.svelte';
	import {
		RemoteGenerationSettingsCardState,
		type GenerationSettingsKey,
	} from './remote-generation-settings-card-state.svelte';

	interface Props {
		settingsKey: GenerationSettingsKey;
		enabledLabel?: string;
		modelLabel: string;
		blurb?: string;
		showDirectoryPrefix?: boolean;
		promptKind?: GenerationPromptKind;
	}

	let {
		settingsKey,
		enabledLabel,
		modelLabel,
		blurb,
		showDirectoryPrefix = false,
		promptKind,
	}: Props = $props();
	let promptDialogOpen = $state(false);

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
	});

	let defaultPrompt = $derived(
		promptKind === 'prompt-refinement'
			? DEFAULT_PROMPT_REFINEMENT_PROMPT
			: DEFAULT_COMMIT_MESSAGE_PROMPT,
	);

	async function savePrompt(customPrompt: string) {
		const result = await cardState.persistPrompt(customPrompt);
		if (result.ok) promptDialogOpen = false;
		return result;
	}

	function saveContextWindow(event: Event): void {
		const contextWindowTokens = parseAgentSwitchContextWindowTokens(
			Number((event.currentTarget as HTMLSelectElement).value),
		);
		if (contextWindowTokens !== null) {
			void cardState.persistContextWindowTokens(contextWindowTokens);
		}
	}
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
					await cardState.persistEnabled(Boolean(next));
				}}
				aria-label={enabledLabel}
			/>
		</div>
	{/if}

	{#if cardState.enabled}
		{#if settingsKey === 'agentSwitchCompaction'}
			<div class="flex items-center justify-between gap-3 py-2">
				<label
					for="agent-switch-context-window"
					class="text-sm font-medium text-foreground"
				>
					{m.settings_agent_switch_compaction_context_window()}
				</label>
				<select
					id="agent-switch-context-window"
					class="rounded-md border border-border bg-muted px-2 py-1 text-base text-foreground sm:text-sm"
					value={cardState.contextWindowTokens}
					disabled={cardState.isSaving}
					onchange={saveContextWindow}
				>
					<option value={200000}>{m.settings_context_window_200000()}</option>
					<option value={500000}>{m.settings_context_window_500000()}</option>
					<option value={1000000}>{m.settings_context_window_1000000()}</option>
				</select>
			</div>
		{/if}

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

		{#if blurb}
			<div class="pb-2 text-xs leading-4 text-muted-foreground">{blurb}</div>
		{/if}

		{#if promptKind}
			<div class="flex justify-end py-2">
				<Button
					variant="outline"
					size="sm"
					disabled={cardState.isSaving}
					onclick={() => {
						promptDialogOpen = true;
					}}
				>
					<Pencil />
					{m.settings_generation_prompt_edit()}
				</Button>
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
						await cardState.persistDirectoryPrefixEnabled(Boolean(next));
					}}
					aria-label={m.settings_commit_add_common_directory_prefix_aria()}
				/>
			</div>
		{/if}
	{/if}
</div>

{#if promptDialogOpen && promptKind}
	<GenerationPromptDialog
		kind={promptKind}
		initialPrompt={cardState.customPrompt}
		{defaultPrompt}
		onSave={savePrompt}
		onCancel={() => {
			promptDialogOpen = false;
		}}
	/>
{/if}
