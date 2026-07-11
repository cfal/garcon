<script lang="ts">
	import {
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
	} from '$shared/agents';
	import { agentLabelFor } from '$lib/i18n/agent-labels';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import ColoredTag from './ColoredTag.svelte';

	interface Props {
		agentId: string;
		tags: string[];
		tagLimit?: number;
		onTagClick?: (tag: string) => void;
		onManageTags?: () => void;
		class?: string;
	}

	let {
		agentId,
		tags,
		tagLimit = 2,
		onTagClick,
		onManageTags,
		class: className,
	}: Props = $props();

	const AGENT_TAG_VARIANTS: Record<string, string> = {
		claude: 'border-provider-claude-border bg-provider-claude-bg text-provider-claude-foreground',
		codex: 'border-provider-codex-border bg-provider-codex-bg text-provider-codex-foreground',
		cursor: 'border-provider-cursor-border bg-provider-cursor-bg text-provider-cursor-foreground',
		opencode:
			'border-provider-opencode-border bg-provider-opencode-bg text-provider-opencode-foreground',
		amp: 'border-provider-amp-border bg-provider-amp-bg text-provider-amp-foreground',
		factory:
			'border-provider-factory-border bg-provider-factory-bg text-provider-factory-foreground',
		pi: 'border-provider-pi-border bg-provider-pi-bg text-provider-pi-foreground',
		[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]:
			'border-border bg-muted text-foreground',
		[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]:
			'border-border bg-muted text-foreground',
		[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: 'border-border bg-muted text-foreground',
	};

	let visibleTags = $derived(tags.slice(0, tagLimit));
	let overflowCount = $derived(Math.max(0, tags.length - tagLimit));
	let agentTagVariant = $derived(AGENT_TAG_VARIANTS[agentId] ?? AGENT_TAG_VARIANTS.claude);
	let agentTagLabel = $derived(agentLabelFor(agentId, agentId || m.agent_claude()));

	function handleTagClick(event: MouseEvent, tag: string): void {
		event.stopPropagation();
		onTagClick?.(tag);
	}

	function handleOverflowClick(event: MouseEvent): void {
		event.stopPropagation();
		onManageTags?.();
	}
</script>

<div class={cn('flex items-center gap-1', className)}>
	<ColoredTag label={agentTagLabel} variant={agentTagVariant} />
	{#each visibleTags as tag (tag)}
		<ColoredTag
			label={tag}
			autoColor
			onclick={onTagClick ? (event) => handleTagClick(event, tag) : undefined}
		/>
	{/each}
	{#if overflowCount > 0}
		{#if onManageTags}
			<button
				type="button"
				class="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
				onclick={handleOverflowClick}
			>
				+{overflowCount}
			</button>
		{:else}
			<span class="text-[10px] text-muted-foreground">+{overflowCount}</span>
		{/if}
	{/if}
</div>
