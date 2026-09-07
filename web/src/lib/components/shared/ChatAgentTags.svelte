<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import AgentPill from './AgentPill.svelte';
	import ColoredTag from './ColoredTag.svelte';

	interface Props {
		agentId: string;
		tags: string[];
		tagLimit?: number;
		wrap?: 'none' | 'two-lines';
		onTagClick?: (tag: string) => void;
		onManageTags?: () => void;
		class?: string;
	}

	let {
		agentId,
		tags,
		tagLimit = 2,
		wrap = 'none',
		onTagClick,
		onManageTags,
		class: className,
	}: Props = $props();

	let visibleTags = $derived(tags.slice(0, tagLimit));
	let overflowCount = $derived(Math.max(0, tags.length - tagLimit));

	function handleTagClick(event: MouseEvent, tag: string): void {
		event.stopPropagation();
		onTagClick?.(tag);
	}

	function handleOverflowClick(event: MouseEvent): void {
		event.stopPropagation();
		onManageTags?.();
	}
</script>

<div
	class={cn(
		'flex items-center gap-1',
		wrap === 'two-lines' ? 'max-h-10 flex-wrap overflow-hidden' : 'overflow-hidden whitespace-nowrap',
		className,
	)}
>
	<AgentPill {agentId} label={agentId || m.agent_claude()} fallbackAgentId="claude" />
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
