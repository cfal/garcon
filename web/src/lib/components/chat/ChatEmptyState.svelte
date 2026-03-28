<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { getAppShell, getModelCatalog, getPreferences } from '$lib/context';
	import ProviderBadge from '$lib/components/shared/ProviderBadge.svelte';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import FolderSearch from '@lucide/svelte/icons/folder-search';
	import * as m from '$lib/paraglide/messages.js';

	const appShell = getAppShell();
	const preferences = getPreferences();
	const modelCatalog = getModelCatalog();

	const defaultProvider = $derived(preferences.selectedProvider);
	const defaultModel = $derived.by(() => {
		const selectedModel =
			defaultProvider === 'codex'
				? preferences.codexModel
				: defaultProvider === 'opencode'
					? preferences.opencodeModel
					: defaultProvider === 'amp'
						? preferences.ampModel
						: preferences.claudeModel;
		return (
			modelCatalog.getModels(defaultProvider).find((model) => model.value === selectedModel)?.label ??
			selectedModel
		);
	});

	function openNewChat() {
		appShell.openNewChatDialog();
	}

	function openAgentSettings() {
		appShell.openSettings('agents');
	}
</script>


<div class="h-full grid place-items-center px-5 py-8 sm:px-8">
	<div class="w-full max-w-4xl rounded-[2rem] border border-border/70 bg-card/95 p-6 shadow-[0_24px_80px_-48px_rgba(0,0,0,0.65)] sm:p-8 lg:p-10">
		<div class="grid gap-8 lg:grid-cols-[1.25fr_0.9fr] lg:items-start">
			<div class="space-y-5">
				<div class="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/60 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
					<Sparkles class="size-3.5" />
					{m.chat_empty_badge()}
				</div>
				<div class="space-y-3">
					<h2 class="max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
						{m.chat_empty_title()}
					</h2>
					<p class="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
						{m.chat_empty_description()}
					</p>
				</div>

				<div class="flex flex-wrap items-center gap-3">
					<ProviderBadge provider={defaultProvider} size="md" />
					<span class="inline-flex items-center rounded-full border border-border/70 bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
						{m.chat_empty_default_model()}: <span class="ml-1 text-foreground">{defaultModel}</span>
					</span>
				</div>

				<div class="flex flex-wrap gap-3 pt-1">
					<Button onclick={openNewChat} class="min-w-[9.5rem]">{m.command_new_chat()}</Button>
					<Button variant="outline" onclick={openAgentSettings} class="min-w-[9.5rem]">
						{m.chat_empty_review_providers()}
					</Button>
				</div>
			</div>

			<div class="rounded-[1.5rem] border border-border/70 bg-background/75 p-5 sm:p-6">
				<div class="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
					{m.chat_empty_quick_start()}
				</div>
				<div class="mt-4 space-y-4">
					<div class="flex items-start gap-3 rounded-2xl border border-border/60 bg-muted/35 px-4 py-3">
						<div class="mt-0.5 flex size-8 items-center justify-center rounded-full bg-status-processing/15 text-status-processing-foreground">
							<Sparkles class="size-4" />
						</div>
						<div>
							<div class="text-sm font-medium text-foreground">{m.chat_empty_tip_intent_title()}</div>
							<div class="mt-1 text-xs leading-5 text-muted-foreground">
								{m.chat_empty_tip_intent_body()}
							</div>
						</div>
					</div>
					<div class="flex items-start gap-3 rounded-2xl border border-border/60 bg-muted/35 px-4 py-3">
						<div class="mt-0.5 flex size-8 items-center justify-center rounded-full bg-status-success/20 text-status-success-foreground">
							<FolderSearch class="size-4" />
						</div>
						<div>
							<div class="text-sm font-medium text-foreground">{m.chat_empty_tip_workspace_title()}</div>
							<div class="mt-1 text-xs leading-5 text-muted-foreground">
								{m.chat_empty_tip_workspace_body()}
							</div>
						</div>
					</div>
					<div class="flex items-start gap-3 rounded-2xl border border-border/60 bg-muted/35 px-4 py-3">
						<div class="mt-0.5 flex size-8 items-center justify-center rounded-full bg-status-warning/16 text-status-warning-foreground">
							<SlidersHorizontal class="size-4" />
						</div>
						<div>
							<div class="text-sm font-medium text-foreground">{m.chat_empty_tip_tune_title()}</div>
							<div class="mt-1 text-xs leading-5 text-muted-foreground">
								{m.chat_empty_tip_tune_body()}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
