<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import SettingsModelSelector from '$lib/components/model-selector/SettingsModelSelector.svelte';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
		ModelSelectorValue,
	} from '$lib/components/model-selector/model-selector-types';
	import { getModelCatalog, getRemoteSettings } from '$lib/context';
	import { DEFAULT_COMMIT_MESSAGE_PROMPT } from '$lib/stores/git/commit-message-default-prompt';
	import type { SessionAgentId } from '$lib/types/app';
	import * as m from '$lib/paraglide/messages.js';
	import type { GenerationUiSettings, RemoteUiSettings } from '$shared/settings';
	import type { ApiProtocol } from '$shared/api-providers';

	type GenerationSettingsKey = 'chatTitle' | 'commitMessage';

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
	};

	let saveError = $state<string | null>(null);
	let selectionOverride = $state<ModelSelectorValue | null>(null);
	let selectionSaveToken = 0;
	let promptDraft = $state(DEFAULT_COMMIT_MESSAGE_PROMPT);
	let promptHydrationKey = $state('');

	let hasEnabledSwitch = $derived(settingsKey === 'chatTitle' && Boolean(enabledLabel));
	let persistedSettings = $derived<GenerationUiSettings>(
		remoteSettings.snapshot?.ui?.[settingsKey] ?? {},
	);
	let effectiveSettings = $derived<GenerationUiSettings>(
		remoteSettings.snapshot?.uiEffective?.[settingsKey] ?? {},
	);
	let enabled = $derived(hasEnabledSwitch ? effectiveSettings.enabled !== false : true);
	let provider = $derived<SessionAgentId>(
		selectionOverride?.agentId ?? (effectiveSettings.agentId as SessionAgentId) ?? 'claude',
	);
	let rawModel = $derived(effectiveSettings.model ?? '');
	let modelEndpointId = $derived(
		selectionOverride?.modelEndpointId ?? effectiveSettings.modelEndpointId ?? null,
	);
	let modelProtocol = $derived<ApiProtocol | null>(
		selectionOverride?.modelProtocol ?? effectiveSettings.modelProtocol ?? null,
	);
	let apiProviderId = $derived(selectionOverride?.apiProviderId ?? effectiveSettings.apiProviderId ?? null);
	let modelValue = $derived(
		selectionOverride?.model ?? modelCatalog.selectionValueFor(provider, rawModel, modelEndpointId),
	);
	let selectorValue = $derived({
		agentId: provider,
		model: modelValue,
		apiProviderId,
		modelEndpointId,
		modelProtocol,
	});
	let directoryPrefixEnabled = $derived(effectiveSettings.useCommonDirPrefix === true);
	let isDefaultPrompt = $derived(
		promptDraft.trim().length === 0 || promptDraft === DEFAULT_COMMIT_MESSAGE_PROMPT,
	);

	$effect(() => {
		if (!showPrompt) return;
		const snapshotVersion = remoteSettings.snapshot?.version ?? 0;
		const persistedPrompt =
			typeof persistedSettings.customPrompt === 'string' ? persistedSettings.customPrompt : '';
		const nextHydrationKey = `${settingsKey}:${snapshotVersion}:${persistedPrompt}`;
		if (promptHydrationKey === nextHydrationKey) return;
		promptDraft = persistedPrompt.trim() ? persistedPrompt : DEFAULT_COMMIT_MESSAGE_PROMPT;
		promptHydrationKey = nextHydrationKey;
	});

	function settingsForSave(settings: GenerationUiSettings): GenerationUiSettings {
		const nextSettings = { ...settings };
		if (!hasEnabledSwitch) delete nextSettings.enabled;
		return nextSettings;
	}

	async function saveGenerationSettings(nextSettings: GenerationUiSettings): Promise<boolean> {
		saveError = null;
		try {
			const ui = { [settingsKey]: settingsForSave(nextSettings) } as Partial<RemoteUiSettings>;
			await remoteSettings.update({ ui });
			return true;
		} catch (error) {
			saveError = error instanceof Error ? error.message : m.settings_save_failed();
			return false;
		}
	}

	async function persistSettings(overrides: GenerationUiSettings = {}): Promise<boolean> {
		const nextProvider =
			typeof overrides.agentId === 'string' ? (overrides.agentId as SessionAgentId) : provider;
		const nextModelValue =
			typeof overrides.model === 'string' ? overrides.model : modelValue;
		const nextEndpointId =
			overrides.modelEndpointId !== undefined ? overrides.modelEndpointId : modelEndpointId;
		const selection = modelCatalog.selectionFor(nextProvider, nextModelValue, nextEndpointId);
		const nextSettings: GenerationUiSettings = {
			...persistedSettings,
			...overrides,
			agentId: nextProvider,
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		};
		if (hasEnabledSwitch) {
			nextSettings.enabled = typeof overrides.enabled === 'boolean' ? overrides.enabled : enabled;
		}
		return saveGenerationSettings(nextSettings);
	}

	async function persistSelection(next: ModelSelectorChange): Promise<void> {
		const previousOverride = selectionOverride;
		const token = ++selectionSaveToken;
		selectionOverride = {
			agentId: next.agentId,
			model: next.modelValue,
			apiProviderId: next.apiProviderId,
			modelEndpointId: next.modelEndpointId,
			modelProtocol: next.modelProtocol,
		};

		const nextSettings: GenerationUiSettings = {
			...persistedSettings,
			agentId: next.agentId,
			model: next.model,
			apiProviderId: next.apiProviderId,
			modelEndpointId: next.modelEndpointId,
			modelProtocol: next.modelProtocol,
		};
		if (hasEnabledSwitch) nextSettings.enabled = enabled;
		const saved = await saveGenerationSettings(nextSettings);
		if (token !== selectionSaveToken) return;
		selectionOverride = saved ? null : previousOverride;
	}

	async function persistPromptDraft(): Promise<void> {
		await persistSettings({
			customPrompt: isDefaultPrompt ? '' : promptDraft,
		});
	}

	async function restoreDefaultPrompt(): Promise<void> {
		promptDraft = DEFAULT_COMMIT_MESSAGE_PROMPT;
		await persistSettings({ customPrompt: '' });
	}
</script>

<div class="bg-muted/50 border border-border rounded-lg px-4">
	{#if saveError}
		<div
			class="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
		>
			{saveError}
		</div>
	{/if}

	{#if hasEnabledSwitch && enabledLabel}
		<div class="flex items-center justify-between py-2">
			<div class="text-sm font-medium text-foreground">{enabledLabel}</div>
			<Switch
				checked={enabled}
				onCheckedChange={async (next) => {
					await persistSettings({ enabled: Boolean(next) });
				}}
				aria-label={enabledLabel}
			/>
		</div>
	{/if}

	{#if enabled}
		<div class="flex items-center justify-between py-2">
			<div class="text-sm font-medium text-foreground">{modelLabel}</div>
			<SettingsModelSelector
				value={selectorValue}
				mode={selectorMode}
				onChange={persistSelection}
				align="end"
				side="bottom"
			/>
		</div>

		{#if showPrompt}
			<div class="space-y-1.5 py-2">
				<div class="text-sm font-medium text-foreground">
					{m.settings_commit_generation_prompt()}
				</div>
				<textarea
					value={promptDraft}
					oninput={(event) => {
						promptDraft = event.currentTarget.value;
					}}
					onblur={persistPromptDraft}
					aria-label={m.settings_commit_generation_prompt()}
					placeholder={m.settings_commit_prompt_placeholder({
						files: '{{files}}',
						diff: '{{diff}}',
					})}
					class="w-full text-sm p-2.5 bg-muted/30 border border-border rounded-md resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent text-foreground placeholder:text-muted-foreground/60"
					rows="8"
				></textarea>
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
				{#if !isDefaultPrompt}
					<div class="flex justify-end">
						<Button variant="outline" size="sm" onclick={restoreDefaultPrompt}>
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
					checked={directoryPrefixEnabled}
					onCheckedChange={async (next) => {
						await persistSettings({ useCommonDirPrefix: Boolean(next) });
					}}
					aria-label={m.settings_commit_add_common_directory_prefix_aria()}
				/>
			</div>
		{/if}
	{/if}
</div>
