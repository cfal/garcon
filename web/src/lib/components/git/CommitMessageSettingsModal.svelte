<script lang="ts">
	// Modal for configuring commit message AI generation. Allows
	// enabling/disabling generation and selecting provider + model.
	// Settings are persisted to app settings under ui.commitMessage.

	import { onMount } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { getModelCatalog } from '$lib/context';
	import { getSettings, updateSettings } from '$lib/api/settings.js';
	import type { SessionProvider } from '$lib/types/app';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		onClose: () => void;
		onSettingsChanged: (settings: {
			enabled: boolean;
			provider: string;
			model: string;
			customPrompt: string;
			useCommonDirPrefix: boolean;
		}) => void;
	}

	let { onClose, onSettingsChanged }: Props = $props();

	let enabled = $state(true);
	let provider = $state<SessionProvider>('claude');
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
	let availableModels = $derived(modelCatalog.getModels(provider));
	let availableProviders = $derived(modelCatalog.getProviders());
	let loaded = $state(false);

		onMount(async () => {
			try {
				const settings = await getSettings();
				const ui = (settings.ui ?? {}) as Record<string, unknown>;
				const uiEffective = (settings.uiEffective ?? {}) as Record<string, unknown>;
				const persistedCommitMessage = (ui.commitMessage ?? {}) as Record<string, unknown>;
				const effectiveCommitMessage = (uiEffective.commitMessage ?? {}) as Record<string, unknown>;
				const cm = { ...persistedCommitMessage, ...effectiveCommitMessage } as Record<string, unknown>;
				enabled = cm.enabled !== false;
			if (['claude', 'codex', 'opencode', 'amp'].includes(cm.provider as string)) {
				provider = cm.provider as SessionProvider;
			}
			if (typeof cm.model === 'string') model = cm.model;
			if (typeof cm.customPrompt === 'string' && cm.customPrompt) customPrompt = cm.customPrompt;
			else customPrompt = DEFAULT_PROMPT;
			if (typeof cm.useCommonDirPrefix === 'boolean') useCommonDirPrefix = cm.useCommonDirPrefix;
		} catch { /* use defaults */ }

		await modelCatalog.refreshIfStale();
		if (!model) {
			const models = modelCatalog.getModels(provider);
			if (models.length > 0) model = models[0].value;
		}

		loaded = true;
	});

	async function persist() {
		// Store empty string when the prompt matches the default so the
		// server uses its built-in prompt (avoids drift if the default changes).
		const promptToStore = isDefaultPrompt ? '' : customPrompt;
		const payload = { enabled, provider, model, customPrompt: promptToStore, useCommonDirPrefix };
		await updateSettings({ ui: { commitMessage: payload } });
		onSettingsChanged({ enabled, provider, model, customPrompt: promptToStore, useCommonDirPrefix });
	}

	async function handleEnabledChange(next: boolean) {
		enabled = next;
		await persist();
	}

	async function handleProviderChange(e: Event) {
		provider = (e.currentTarget as HTMLSelectElement).value as SessionProvider;
		const models = modelCatalog.getModels(provider);
		if (!models.some((opt) => opt.value === model)) {
			model = models[0]?.value ?? '';
		}
		await persist();
	}

	function providerLabel(currentProvider: SessionProvider): string {
		if (currentProvider === 'claude') return m.provider_claude();
		if (currentProvider === 'codex') return m.provider_codex();
		if (currentProvider === 'amp') return m.provider_amp();
		return m.provider_opencode();
	}

	async function handleModelChange(e: Event) {
		model = (e.currentTarget as HTMLSelectElement).value;
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
	<div class="bg-background border border-border rounded-lg shadow-xl w-[440px] max-h-[85vh] overflow-y-auto">
		<div class="flex items-center justify-between px-4 py-3 border-b border-border">
			<h2 class="text-sm font-medium text-foreground">Commit message generation</h2>
			<button
				onclick={onClose}
				class="p-1 rounded hover:bg-muted transition-colors text-muted-foreground"
			>
				<X class="w-4 h-4" />
			</button>
		</div>

			{#if loaded}
				<div class="px-4 py-3 space-y-3">
					<div class="flex items-center justify-between">
						<div class="text-sm font-medium text-foreground">Directory prefix</div>
						<Switch
							checked={useCommonDirPrefix}
							onCheckedChange={(next) => { useCommonDirPrefix = next; persist(); }}
							aria-label="Prefix commit message with common directory"
						/>
					</div>

					<div class="flex items-center justify-between">
						<div class="text-sm font-medium text-foreground">Enabled</div>
						<Switch
							checked={enabled}
							onCheckedChange={handleEnabledChange}
						aria-label="Enable commit message generation"
					/>
				</div>

				{#if enabled}
					<div class="flex items-center justify-between">
						<div class="text-sm font-medium text-foreground">{m.settings_chat_title_provider()}</div>
						<select
							class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground"
							value={provider}
							onchange={handleProviderChange}
						>
							{#each availableProviders as availableProvider (availableProvider)}
								<option value={availableProvider}>{providerLabel(availableProvider)}</option>
							{/each}
						</select>
					</div>

					<div class="flex items-center justify-between">
						<div class="text-sm font-medium text-foreground">{m.settings_chat_title_model()}</div>
						<select
							class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground max-w-[180px] truncate"
							value={model}
							onchange={handleModelChange}
						>
							{#each availableModels as opt (opt.value)}
								<option value={opt.value}>{opt.label}</option>
							{/each}
						</select>
					</div>

						<div class="space-y-1.5 pt-1">
							<div class="text-sm font-medium text-foreground">Generation prompt</div>
							<textarea
								value={customPrompt}
								oninput={(e) => { customPrompt = e.currentTarget.value; }}
								onblur={() => persist()}
							placeholder={'Leave empty for default prompt. Use {{files}} and {{diff}} as placeholders.'}
							class="w-full text-sm p-2.5 bg-muted/30 border border-border rounded-md resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent text-foreground placeholder:text-muted-foreground/60"
								rows="8"
							></textarea>
							<div class="rounded-md border border-border bg-muted/20 px-3 py-2">
								<div class="text-xs font-medium text-foreground">
									{m.git_commit_settings_prompt_legend_title()}
								</div>
								<div class="mt-1 space-y-1 text-xs text-muted-foreground">
									<div><code class="font-mono text-foreground">{'{{files}}'}</code> {m.git_commit_settings_prompt_legend_files()}</div>
									<div><code class="font-mono text-foreground">{'{{diff}}'}</code> {m.git_commit_settings_prompt_legend_diff()}</div>
								</div>
							</div>
							{#if !isDefaultPrompt}
								<div class="flex justify-end">
									<Button
										variant="outline"
										size="sm"
										onclick={() => { customPrompt = DEFAULT_PROMPT; persist(); }}
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
				Loading...
			</div>
		{/if}
	</div>
</div>
