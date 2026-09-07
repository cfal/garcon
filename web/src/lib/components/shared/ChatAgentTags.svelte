<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import {
		observeChatAgentTagsSize,
		selectFittingTagPrefix,
	} from './chat-agent-tags-layout.js';
	import AgentPill from './AgentPill.svelte';
	import ColoredTag from './ColoredTag.svelte';

	interface Props {
		agentId: string;
		tags: string[];
		tagLimit?: number;
		wrap?: 'flow' | 'none' | 'two-lines';
		onTagClick?: (tag: string) => void;
		onManageTags?: () => void;
		class?: string;
	}

	let {
		agentId,
		tags,
		tagLimit = 2,
		wrap = 'flow',
		onTagClick,
		onManageTags,
		class: className,
	}: Props = $props();

	const OVERFLOW_CLASS = 'shrink-0 text-[10px] text-muted-foreground';
	let root: HTMLDivElement | undefined = $state();
	let measurementRail: HTMLDivElement | undefined = $state();
	let measuredVisibleTagCount: number | null = $state(null);
	let maximumVisibleTagCount = $derived(
		Math.min(tags.length, Math.max(0, Math.floor(tagLimit))),
	);
	let visibleTagCount = $derived(
		wrap === 'two-lines'
			? Math.min(measuredVisibleTagCount ?? maximumVisibleTagCount, maximumVisibleTagCount)
			: maximumVisibleTagCount,
	);
	let visibleTags = $derived(tags.slice(0, visibleTagCount));
	let overflowCount = $derived(Math.max(0, tags.length - visibleTagCount));
	let measuredTags = $derived(tags.slice(0, maximumVisibleTagCount));
	let overflowMeasureCounts = $derived(
		Array.from({ length: maximumVisibleTagCount + 1 }, (_, count) => tags.length - count).filter(
			(count) => count > 0,
		),
	);
	let measurementKey = $derived(`${agentId}:${tagLimit}:${tags.join('\u0000')}`);
	let rootLayoutClass = $derived.by(() => {
		if (wrap === 'two-lines') return 'max-h-10 flex-wrap overflow-hidden';
		if (wrap === 'none') return 'overflow-hidden whitespace-nowrap';
		return undefined;
	});

	function recomputeVisibleTags(availableWidth: number): void {
		const rail = measurementRail;
		if (!root || !rail || availableWidth <= 0) return;
		const agentWidth =
			rail
				.querySelector<HTMLElement>('[data-chat-agent-tags-agent-measure]')
				?.getBoundingClientRect().width ?? 0;
		const tagWidths = Array.from(
			rail.querySelectorAll<HTMLElement>('[data-chat-agent-tags-tag-measure]'),
			(element) => element.getBoundingClientRect().width,
		);
		const overflowWidths = new Map<number, number>();
		for (const element of rail.querySelectorAll<HTMLElement>(
			'[data-chat-agent-tags-overflow-measure]',
		)) {
			const hiddenCount = Number(element.dataset.chatAgentTagsOverflowMeasure);
			if (Number.isSafeInteger(hiddenCount)) {
				overflowWidths.set(hiddenCount, element.getBoundingClientRect().width);
			}
		}
		const computedGap = Number.parseFloat(getComputedStyle(root).columnGap);
		measuredVisibleTagCount = selectFittingTagPrefix({
			availableWidth,
			agentWidth,
			tagWidths,
			totalTagCount: tags.length,
			overflowWidths,
			gap: Number.isFinite(computedGap) ? computedGap : 4,
			maxRows: 2,
		});
	}

	$effect(() => {
		const actionRoot = root;
		const rail = measurementRail;
		const inputKey = measurementKey;
		if (wrap !== 'two-lines') {
			measuredVisibleTagCount = null;
			return;
		}
		if (!actionRoot || !rail) return;
		let disposed = false;
		let availableWidth = actionRoot.getBoundingClientRect().width;
		const recompute = () => recomputeVisibleTags(availableWidth);
		queueMicrotask(() => {
			if (!disposed && inputKey === measurementKey) recompute();
		});
		const stopRootObservation = observeChatAgentTagsSize(actionRoot, (entry) => {
			availableWidth = entry.contentRect.width;
			recompute();
		});
		const stopRailObservation = observeChatAgentTagsSize(rail, recompute);
		return () => {
			disposed = true;
			stopRootObservation();
			stopRailObservation();
		};
	});

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
	bind:this={root}
	data-slot="chat-agent-tags"
	class={cn(
		'flex items-center gap-1',
		rootLayoutClass,
		className,
	)}
>
	<AgentPill {agentId} label={agentId || m.agent_claude()} fallbackAgentId="claude" />
	{#each visibleTags as tag (tag)}
		<ColoredTag
			label={tag}
			autoColor
			class={wrap === 'two-lines'
				? 'min-w-0 max-w-full shrink-0 overflow-hidden text-ellipsis whitespace-nowrap'
				: undefined}
			onclick={onTagClick ? (event) => handleTagClick(event, tag) : undefined}
		/>
	{/each}
	{#if overflowCount > 0}
		{#if onManageTags}
			<button
				type="button"
				class="{OVERFLOW_CLASS} transition-colors hover:text-foreground"
				onclick={handleOverflowClick}
			>
				+{overflowCount}
			</button>
		{:else}
			<span class={OVERFLOW_CLASS}>+{overflowCount}</span>
		{/if}
	{/if}
</div>

{#if wrap === 'two-lines'}
	<div
		bind:this={measurementRail}
		aria-hidden="true"
		class="pointer-events-none invisible fixed top-0 left-0 flex w-max items-center gap-1"
		data-slot="chat-agent-tags-measurement"
	>
		<span class="inline-flex shrink-0" data-chat-agent-tags-agent-measure>
			<AgentPill {agentId} label={agentId || m.agent_claude()} fallbackAgentId="claude" />
		</span>
		{#each measuredTags as tag, index (`${index}:${tag}`)}
			<span class="inline-flex shrink-0" data-chat-agent-tags-tag-measure>
				<ColoredTag label={tag} autoColor />
			</span>
		{/each}
		{#each overflowMeasureCounts as count (count)}
			<span class={OVERFLOW_CLASS} data-chat-agent-tags-overflow-measure={count}>+{count}</span>
		{/each}
	</div>
{/if}
