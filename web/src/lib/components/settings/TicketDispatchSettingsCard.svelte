<script lang="ts">
	import Pencil from '@lucide/svelte/icons/pencil';
	import SettingsModelSelector from '$lib/components/model-selector/SettingsModelSelector.svelte';
	import type { ModelSelectorMode } from '$lib/components/model-selector/model-selector-types';
	import { Button } from '$lib/components/ui/button';
	import { getModelCatalog } from '$lib/context';
	import { getTicketDispatch } from '$lib/context/tickets-context.js';
	import { ticketDispatchAgentIds } from '$lib/tickets/dispatch/ticket-dispatch-selection.js';
	import * as m from '$lib/paraglide/messages.js';
	import { DEFAULT_TICKET_DISPATCH_PROMPT } from '$shared/ticket-dispatch';
	import GenerationPromptDialog from './GenerationPromptDialog.svelte';

	const dispatch = getTicketDispatch();
	const modelCatalog = getModelCatalog();
	const selectorMode: ModelSelectorMode = {
		executor: 'select',
		agent: 'select',
		source: 'select',
		surface: 'settings',
		effort: 'select',
	};
	let promptDialogOpen = $state(false);
	const unavailable = $derived(
		dispatch.resolution.kind !== 'ready' && !dispatch.selectionOverride,
	);

	async function savePrompt(customPrompt: string) {
		const result = await dispatch.persistPrompt(customPrompt);
		if (result.ok) promptDialogOpen = false;
		return result;
	}
</script>

<div class="bg-muted/50 border border-border rounded-lg px-4">
	{#if dispatch.saveError}
		<div
			class="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
		>
			{dispatch.saveError}
		</div>
	{/if}

	<div class="flex flex-col items-start justify-between gap-3 pb-1 pt-2 sm:flex-row">
		<div class="pt-1.5 text-sm font-medium text-foreground">
			{m.settings_ticket_dispatch_model()}
		</div>
		<div class="flex min-w-0 max-w-full flex-col items-start gap-1 sm:items-end">
			<Button
				variant={dispatch.followsNewChatDefaults ? 'secondary' : 'ghost'}
				size="sm"
				aria-pressed={dispatch.followsNewChatDefaults}
				disabled={dispatch.saving}
				onclick={() => dispatch.followNewChat()}>{m.settings_ticket_dispatch_follow_new_chat()}</Button
			>
			<SettingsModelSelector
				value={dispatch.selectorValue}
				mode={selectorMode}
				onChange={(next) => dispatch.persistSelection(next)}
				getSelectableAgentIds={(executorId) =>
					ticketDispatchAgentIds(modelCatalog.forExecutor(executorId))}
				align="end"
				side="bottom"
				disabled={dispatch.saving}
			/>
			{#if unavailable}
				<span class="text-xs text-destructive" role="status">
					{m.tickets_dispatch_model_unavailable()}
				</span>
			{/if}
		</div>
	</div>

	<div class="pb-2 text-xs leading-4 text-muted-foreground">
		{m.settings_ticket_dispatch_hint()}
	</div>

	<div class="flex justify-end py-2">
		<Button
			variant="outline"
			size="sm"
			disabled={dispatch.saving}
			onclick={() => {
				promptDialogOpen = true;
			}}
		>
			<Pencil />
			{m.settings_ticket_dispatch_prompt_edit()}
		</Button>
	</div>
</div>

{#if promptDialogOpen}
	<GenerationPromptDialog
		kind="ticket-dispatch"
		initialPrompt={dispatch.customPrompt}
		defaultPrompt={DEFAULT_TICKET_DISPATCH_PROMPT}
		onSave={savePrompt}
		onCancel={() => {
			promptDialogOpen = false;
		}}
	/>
{/if}
