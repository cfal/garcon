<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import AgentPill from '$lib/components/shared/AgentPill.svelte';
	import { getTagColorClasses } from '$lib/utils/tag-colors';
	import type { AgentId } from '$shared/agents';
	import type { PreambleTagMatchMode } from '$shared/preambles';
	import * as m from '$lib/paraglide/messages.js';

	interface AgentOption {
		readonly id: AgentId;
		readonly label: string;
	}

	interface Props {
		agents: readonly AgentOption[];
		selectedAgentIds: readonly AgentId[];
		tags: readonly string[];
		tagMatchMode: PreambleTagMatchMode;
		knownTags: readonly string[];
		disabled?: boolean;
		onToggleAgent: (agentId: AgentId) => boolean;
		onAddTag: (tag: string) => boolean;
		onRemoveTag: (tag: string) => void;
		onTagMatchModeChange: (mode: PreambleTagMatchMode) => void;
	}

	let {
		agents,
		selectedAgentIds,
		tags,
		tagMatchMode,
		knownTags,
		disabled = false,
		onToggleAgent,
		onAddTag,
		onRemoveTag,
		onTagMatchModeChange,
	}: Props = $props();

	let tagInput = $state('');
	let agentError = $state<string | null>(null);
	let tagError = $state<string | null>(null);
	const componentId = $props.id();

	const agentOptions = $derived.by(() => {
		const byId = new Map(agents.map((agent) => [agent.id, agent]));
		for (const agentId of selectedAgentIds) {
			if (!byId.has(agentId)) byId.set(agentId, { id: agentId, label: agentId });
		}
		return [...byId.values()];
	});

	function handleAgentToggle(agentId: AgentId): void {
		agentError = onToggleAgent(agentId) ? null : m.preambles_filter_limit_reached();
	}

	function handleAddTag(): void {
		if (!tagInput.trim()) return;
		if (!onAddTag(tagInput)) {
			tagError = m.preambles_tag_filter_invalid();
			return;
		}
		tagInput = '';
		tagError = null;
	}

	function handleTagKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' && event.key !== ',') return;
		event.preventDefault();
		handleAddTag();
	}
</script>

<fieldset class="space-y-4 rounded-md border border-border p-3">
	<legend class="text-sm font-medium text-foreground">
		{m.preambles_automatic_filters_label()}
	</legend>
	<p class="text-xs text-muted-foreground">
		{m.preambles_automatic_filters_description()}
	</p>

	<div class="space-y-2">
		<p class="text-sm font-medium text-foreground">{m.preambles_agent_filter_label()}</p>
		<p class="text-xs text-muted-foreground">{m.preambles_agent_filter_description()}</p>
		<div class="flex flex-wrap gap-2" data-slot="preamble-agent-filters">
			{#each agentOptions as agent (agent.id)}
				<svelte:boundary>
					<AgentPill
						agentId={agent.id}
						label={agent.label}
						selected={selectedAgentIds.includes(agent.id)}
						{disabled}
						ariaLabel={m.preambles_agent_filter_toggle({ agent: agent.label })}
					onclick={() => handleAgentToggle(agent.id)}
						class="min-h-9 px-3 text-sm transition-opacity hover:opacity-80 disabled:opacity-50"
					/>
					{#snippet failed()}
						<span class="text-xs text-muted-foreground">
							{m.preamble_selection_row_unavailable()}
						</span>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>
		<p class="min-h-4 text-xs text-destructive" role={agentError ? 'alert' : undefined}>
			{agentError ?? ''}
		</p>
	</div>

	<div class="space-y-2">
		<p class="text-sm font-medium text-foreground">{m.preambles_tag_filter_label()}</p>
		<p class="text-xs text-muted-foreground">{m.preambles_tag_filter_description()}</p>
		<div class="flex flex-wrap gap-3 text-sm">
			<label class="flex items-center gap-2">
				<input
					type="radio"
					name={`${componentId}-tag-match-mode`}
					checked={tagMatchMode === 'any'}
					{disabled}
					onchange={() => onTagMatchModeChange('any')}
				/>
				{m.preambles_tag_filter_any()}
			</label>
			<label class="flex items-center gap-2">
				<input
					type="radio"
					name={`${componentId}-tag-match-mode`}
					checked={tagMatchMode === 'all'}
					{disabled}
					onchange={() => onTagMatchModeChange('all')}
				/>
				{m.preambles_tag_filter_all()}
			</label>
		</div>
		<div class="flex flex-wrap items-center gap-1.5">
			{#each tags as tag (tag)}
				<svelte:boundary>
					<button
						type="button"
						class="inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-sm font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 {getTagColorClasses(
							tag,
						)}"
						{disabled}
						onclick={() => onRemoveTag(tag)}
						aria-label={m.preambles_tag_filter_remove({ tag })}
					>
						{tag}
						<X class="h-3 w-3" aria-hidden="true" />
					</button>
					{#snippet failed()}
						<span class="text-xs text-muted-foreground">
							{m.preamble_selection_row_unavailable()}
						</span>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>
		<div class="flex gap-2">
			<input
				type="text"
				list={`${componentId}-known-tags`}
				bind:value={tagInput}
				{disabled}
				onkeydown={handleTagKeydown}
				placeholder={m.preambles_tag_filter_placeholder()}
				aria-label={m.preambles_tag_filter_add_label()}
				aria-invalid={Boolean(tagError)}
				aria-describedby={`${componentId}-tag-filter-error`}
				class="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
			/>
			<datalist id={`${componentId}-known-tags`}>
				{#each knownTags as tag (tag)}
					<option value={tag}></option>
				{/each}
			</datalist>
			<Button
				type="button"
				variant="secondary"
				onclick={handleAddTag}
				disabled={disabled || !tagInput.trim()}
			>
				{m.preambles_tag_filter_add()}
			</Button>
		</div>
		<p
			id={`${componentId}-tag-filter-error`}
			class="min-h-4 text-xs text-destructive"
			role={tagError ? 'alert' : undefined}
		>
			{tagError ?? ''}
		</p>
	</div>
</fieldset>
