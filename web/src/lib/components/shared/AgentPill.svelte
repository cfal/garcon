<script module lang="ts">
	import {
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
	} from '$shared/agents';
	import { agentProviderStyle } from '$lib/agents/agent-provider-style';

	const DEFAULT_VARIANT = 'border-border bg-muted text-foreground';
	// Direct agents are styled neutrally and never borrow their fallback agent's provider style.
	const NEUTRAL_AGENT_IDS: ReadonlySet<string> = new Set([
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
	]);
</script>

<script lang="ts">
	import type { AgentId } from '$shared/agents';
	import { agentLabelFor } from '$lib/agents/agent-labels';
	import { cn } from '$lib/utils/cn';

	interface Props {
		agentId: AgentId;
		label?: string;
		appearance?: 'provider' | 'neutral';
		selected?: boolean;
		disabled?: boolean;
		fallbackAgentId?: AgentId;
		onclick?: (event: MouseEvent) => void;
		ariaLabel?: string;
		class?: string;
	}

	let {
		agentId,
		label,
		appearance = 'provider',
		selected = false,
		disabled = false,
		fallbackAgentId,
		onclick,
		ariaLabel,
		class: className,
	}: Props = $props();

	const resolvedLabel = $derived(agentLabelFor(agentId, label ?? agentId));
	const variant = $derived.by(() => {
		if (appearance === 'neutral' || NEUTRAL_AGENT_IDS.has(agentId)) return DEFAULT_VARIANT;
		return (
			agentProviderStyle(agentId)?.pillClass ??
			agentProviderStyle(fallbackAgentId ?? '')?.pillClass ??
			DEFAULT_VARIANT
		);
	});
	const classes = $derived(
		cn(
			'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none',
			variant,
			selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
			onclick &&
				'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed',
			className,
		),
	);
</script>

{#if onclick}
	<button
		type="button"
		class={classes}
		aria-label={ariaLabel}
		aria-pressed={selected}
		{disabled}
		{onclick}
	>
		{resolvedLabel}
	</button>
{:else}
	<span class={classes}>{resolvedLabel}</span>
{/if}
