<script lang="ts">
	// Split button that dispatches a ticket to a new agent chat. The trailing
	// segment picks the dispatch agent and model; the choice persists as the
	// workspace ticket dispatch setting.
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import ModelSelectorPopover from '$lib/components/model-selector/ModelSelectorPopover.svelte';
	import { buildModelSelectorRecents } from '$lib/components/model-selector/model-selector-recents.js';
	import type { ModelSelectorMode } from '$lib/components/model-selector/model-selector-types.js';
	import { getModelCatalog, getRemoteSettings } from '$lib/context';
	import { getTicketDispatch } from '$lib/context/tickets-context.js';
	import { isDirectAgentId } from '$lib/agents/direct-agents.js';
	import { ticketDispatchAgentIds } from '$lib/tickets/dispatch/ticket-dispatch-selection.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		label,
		pending = false,
		disabled = false,
		onDispatch,
	}: {
		label: string;
		pending?: boolean;
		disabled?: boolean;
		onDispatch: () => void;
	} = $props();
	const dispatch = getTicketDispatch();
	const modelCatalog = getModelCatalog();
	const remoteSettings = getRemoteSettings();
	const mode: ModelSelectorMode = {
		executor: 'select',
		agent: 'select',
		source: 'select',
		surface: 'composer',
		effort: 'select',
	};
	// Dispatch stays enabled while the catalog is cold; dispatch refreshes it and reports failures.
	const unavailable = $derived(dispatch.resolution.kind !== 'ready' && !dispatch.selectionOverride);
</script>

<div class="ticket-dispatch" role="group" aria-label={m.tickets_dispatch_group()}>
	<button
		type="button"
		class="ticket-dispatch-action"
		disabled={disabled || pending}
		aria-busy={pending}
		title={unavailable ? m.tickets_dispatch_model_unavailable() : m.tickets_dispatch_hint()}
		onclick={onDispatch}
	>
		{#if pending}<LoaderCircle size={15} class="animate-spin" aria-hidden="true" />
		{:else}<Sparkles size={15} aria-hidden="true" />{/if}
		{pending ? m.tickets_dispatching() : label}
	</button>
	<ModelSelectorPopover
		value={dispatch.selectorValue}
		{mode}
		onChange={(next) => dispatch.persistSelection(next)}
		getSelectableAgentIds={(executorId) => ticketDispatchAgentIds(modelCatalog.forExecutor(executorId))}
		getRecents={(executorId) =>
			buildModelSelectorRecents(
				modelCatalog.forExecutor(executorId),
				remoteSettings.snapshot?.recentAgentSettings ?? [],
			).filter((recent) => !isDirectAgentId(recent.agentId))}
		disabled={pending || dispatch.saving}
		align="end"
		side="top"
		triggerClass="ticket-dispatch-model"
	/>
</div>
