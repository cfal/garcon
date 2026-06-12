<script lang="ts">
	// Modal for configuring commit message AI generation. Allows
	// enabling/disabling generation and selecting agent + model.
	// Settings are persisted to app settings under ui.commitMessage.

	import { onMount } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { getModelCatalog, getRemoteSettings } from '$lib/context';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ApiProtocol } from '$shared/api-providers';
	import * as m from '$lib/paraglide/messages.js';
	import SettingsModelSelector from '$lib/components/model-selector/SettingsModelSelector.svelte';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
	} from '$lib/components/model-selector/model-selector-types';

	interface Props {
		onClose: () => void;
		onSettingsChanged: (settings: {
			enabled: boolean;
			agentId: SessionAgentId;
			model: string;
			apiProviderId?: string | null;
			modelEndpointId?: string | null;
			modelProtocol?: ApiProtocol | null;
			customPrompt: string;
			useCommonDirPrefix: boolean;
		}) => void;
	}

	let { onClose, onSettingsChanged }: Props = $props();

	let enabled = $state(true);
	let agentId = $state<SessionAgentId>('claude');
	let model = $state('');
	const DEFAULT_PROMPT = `Write a high-quality Conventional Commit message based on the staged changes.

Strict output rules:
- Return plain text only. Do not include markdown, code fences, labels, or commentary.
- First line must follow: type(scope): subject
- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject must be imperative, specific, and 50 characters or fewer
- Add a body only when it improves clarity; wrap body lines to 72 characters or fewer

Content guidance:
- Prioritize user-visible behavior changes
- Include critical technical context when behavior changes depend on it
- Reflect both additions and removals when relevant
- Avoid vague subjects such as "update files" or "misc changes"

Changed files:
{{files}}

Diff excerpt:
{{diff}}

Return only the commit message now.`;

	let customPrompt = $state('');
	let useCommonDirPrefix = $state(false);
	let isDefaultPrompt = $derived(!customPrompt || customPrompt === DEFAULT_PROMPT);
	const modelCatalog = getModelCatalog();
	const remoteSettings = getRemoteSettings();
	const modelSelectorMode: ModelSelectorMode = {
		agent: 'select',
		source: 'select',
		surface: 'settings',
	};
	const modelSelectorValue = $derived({
		agentId,
		model,
	});
	let loaded = $state(false);

	function applyModelDefault(persistedModel: string, persistedEndpointId: string | null): void {
		if (persistedModel) {
			model = modelCatalog.selectionValueFor(agentId, persistedModel, persistedEndpointId);
		}
		if (!model) {
			const models = modelCatalog.getModels(agentId);
			if (models.length > 0) model = models[0].value;
		}
	}

	onMount(async () => {
		let persistedModel = '';
		let persistedEndpointId: string | null = null;
		try {
			const snap = await remoteSettings.ensureLoaded();
			const ui = (snap.ui ?? {}) as Record<string, unknown>;
			const uiEffective = (snap.uiEffective ?? {}) as Record<string, unknown>;
			const persistedCommitMessage = (ui.commitMessage ?? {}) as Record<string, unknown>;
			const effectiveCommitMessage = (uiEffective.commitMessage ?? {}) as Record<string, unknown>;
			const cm = { ...persistedCommitMessage, ...effectiveCommitMessage } as Record<
				string,
				unknown
			>;
			enabled = cm.enabled !== false;
			if (typeof cm.agentId === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(cm.agentId)) {
				agentId = cm.agentId as SessionAgentId;
			}
			if (typeof cm.model === 'string') persistedModel = cm.model;
			if (typeof cm.modelEndpointId === 'string') persistedEndpointId = cm.modelEndpointId;
			if (typeof cm.customPrompt === 'string' && cm.customPrompt) customPrompt = cm.customPrompt;
			else customPrompt = DEFAULT_PROMPT;
			if (typeof cm.useCommonDirPrefix === 'boolean') useCommonDirPrefix = cm.useCommonDirPrefix;
		} catch {
			/* use defaults */
		}

		applyModelDefault(persistedModel, persistedEndpointId);

		loaded = true;
		const agentIdAtLoad = agentId;
		const modelAtLoad = model;
		void modelCatalog
			.refreshIfStale()
			.then(() => {
				if (agentId !== agentIdAtLoad || model !== modelAtLoad) return;
				applyModelDefault(persistedModel, persistedEndpointId);
			})
			.catch((err) => {
				console.warn('[CommitMessageSettingsModal] Failed to refresh models', err);
			});
	});

	async function persist() {
		// Store empty string when the prompt matches the default so the
		// server uses its built-in prompt and avoids drift if the default changes.
		const promptToStore = isDefaultPrompt ? '' : customPrompt;
		const selection = modelCatalog.selectionFor(agentId, model);
		const payload = {
			enabled,
			agentId,
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
			customPrompt: promptToStore,
			useCommonDirPrefix,
		};
		await remoteSettings.update({ ui: { commitMessage: payload } });
		onSettingsChanged({ ...payload, customPrompt: promptToStore, useCommonDirPrefix });
	}

	async function handleEnabledChange(next: boolean) {
		enabled = next;
		await persist();
	}

	async function handleModelSelectorChange(next: ModelSelectorChange) {
		agentId = next.agentId;
		model = next.modelValue;
		await persist();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
	onclick={handleBackdropClick}
	onkeydown={handleKeydown}
>
	<div
		class="bg-background border border-border rounded-lg shadow-xl w-[440px] max-h-[85vh] overflow-y-auto"
	>
		<div class="flex items-center justify-between px-4 py-3 border-b border-border">
			<h2 class="text-sm font-medium text-foreground">{m.git_commit_settings_title()}</h2>
			<button
				aria-label={m.share_dialog_close()}
				onclick={onClose}
				class="p-1 rounded hover:bg-muted transition-colors text-muted-foreground"
			>
				<X class="w-4 h-4" />
			</button>
		</div>

		{#if loaded}
			<div class="px-4 py-3 space-y-3">
				<div class="flex items-center justify-between">
					<div class="text-sm font-medium text-foreground">
						{m.git_commit_settings_directory_prefix()}
					</div>
					<Switch
						checked={useCommonDirPrefix}
						onCheckedChange={(next) => {
							useCommonDirPrefix = next;
							persist();
						}}
						aria-label={m.git_commit_settings_directory_prefix_aria()}
					/>
				</div>

				<div class="flex items-center justify-between">
					<div class="text-sm font-medium text-foreground">{m.git_commit_settings_enabled()}</div>
					<Switch
						checked={enabled}
						onCheckedChange={handleEnabledChange}
						aria-label={m.git_commit_settings_enabled_aria()}
					/>
				</div>

				{#if enabled}
					<div class="flex items-center justify-between">
						<div class="text-sm font-medium text-foreground">{m.git_commit_settings_model()}</div>
						<SettingsModelSelector
							value={modelSelectorValue}
							mode={modelSelectorMode}
							onChange={handleModelSelectorChange}
							align="end"
							side="bottom"
						/>
					</div>

					<div class="space-y-1.5 pt-1">
						<div class="text-sm font-medium text-foreground">
							{m.git_commit_settings_generation_prompt()}
						</div>
						<textarea
							value={customPrompt}
							oninput={(e) => {
								customPrompt = e.currentTarget.value;
							}}
							onblur={() => persist()}
							placeholder={m.git_commit_settings_prompt_placeholder({
								files: '{{files}}',
								diff: '{{diff}}',
							})}
							class="w-full text-sm p-2.5 bg-muted/30 border border-border rounded-md resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent text-foreground placeholder:text-muted-foreground/60"
							rows="8"
						></textarea>
						<div class="rounded-md border border-border bg-muted/20 px-3 py-2">
							<div class="text-xs font-medium text-foreground">
								{m.git_commit_settings_prompt_legend_title()}
							</div>
							<div class="mt-1 space-y-1 text-xs text-muted-foreground">
								<div>
									<code class="font-mono text-foreground">{'{{files}}'}</code>
									{m.git_commit_settings_prompt_legend_files()}
								</div>
								<div>
									<code class="font-mono text-foreground">{'{{diff}}'}</code>
									{m.git_commit_settings_prompt_legend_diff()}
								</div>
							</div>
						</div>
						{#if !isDefaultPrompt}
							<div class="flex justify-end">
								<Button
									variant="outline"
									size="sm"
									onclick={() => {
										customPrompt = DEFAULT_PROMPT;
										persist();
									}}
								>
									{m.git_commit_settings_restore_default_prompt()}
								</Button>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{:else}
			<div class="px-4 py-6 flex items-center justify-center text-muted-foreground text-sm">
				{m.status_loading()}
			</div>
		{/if}
	</div>
</div>
