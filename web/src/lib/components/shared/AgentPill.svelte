<script lang="ts">
	import {
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
		type AgentId,
	} from '$shared/agents';
	import { agentLabelFor } from '$lib/agents/agent-labels';
	import { cn } from '$lib/utils/cn';

	interface Props {
		agentId: AgentId;
		label?: string;
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
		selected = false,
		disabled = false,
		fallbackAgentId,
		onclick,
		ariaLabel,
		class: className,
	}: Props = $props();

	const variants: Record<string, string> = {
		claude: 'border-provider-claude-border bg-provider-claude-bg text-provider-claude-foreground',
		codex: 'border-provider-codex-border bg-provider-codex-bg text-provider-codex-foreground',
		cursor: 'border-provider-cursor-border bg-provider-cursor-bg text-provider-cursor-foreground',
		opencode:
			'border-provider-opencode-border bg-provider-opencode-bg text-provider-opencode-foreground',
		amp: 'border-provider-amp-border bg-provider-amp-bg text-provider-amp-foreground',
		factory:
			'border-provider-factory-border bg-provider-factory-bg text-provider-factory-foreground',
		pi: 'border-provider-pi-border bg-provider-pi-bg text-provider-pi-foreground',
		[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: 'border-border bg-muted text-foreground',
		[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: 'border-border bg-muted text-foreground',
		[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: 'border-border bg-muted text-foreground',
	};

	const resolvedLabel = $derived(agentLabelFor(agentId, label ?? agentId));
	const variant = $derived(
		variants[agentId] ??
			variants[fallbackAgentId ?? ''] ??
			'border-border bg-muted text-foreground',
	);
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
