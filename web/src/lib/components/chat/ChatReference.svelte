<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ChatReferenceResolution } from '$lib/chat/transcript/chat-reference.js';
	import { cn } from '$lib/utils/cn.js';

	interface Props {
		chatId: string;
		resolution: ChatReferenceResolution | null;
		authoredLabel?: Snippet;
		authoredLabelText?: string | null;
		authoredTitle?: string | null;
		class?: string;
		linkClass?: string;
		titleClass?: string;
		idClass?: string;
		inertTooltipPolicy?: 'informative' | 'always';
	}
	const INLINE_LABEL_SEPARATOR = ' ';

	let {
		chatId,
		resolution,
		authoredLabel,
		authoredLabelText = null,
		authoredTitle = null,
		class: className = '',
		linkClass = '',
		titleClass = '',
		idClass = 'text-muted-foreground/80',
		inertTooltipPolicy = 'informative',
	}: Props = $props();

	const title = $derived(resolution?.title ?? null);
	const normalizedAuthoredLabelText = $derived(authoredLabelText?.trim() ?? '');
	const normalizedAuthoredTitle = $derived(authoredTitle?.trim() ?? '');
	const customAuthoredLabel = $derived(
		Boolean(authoredLabel && normalizedAuthoredLabelText && normalizedAuthoredLabelText !== chatId),
	);
	const navigable = $derived(resolution !== null && !resolution.isCurrent);
	const resolvedLabel = $derived(title ? `${title} (${chatId})` : chatId);
	const tooltip = $derived(normalizedAuthoredTitle || resolvedLabel);
	const hasInformativeInertTooltip = $derived(
		inertTooltipPolicy === 'always' ||
			Boolean(normalizedAuthoredTitle) ||
			Boolean(customAuthoredLabel && title),
	);
	const inertTooltip = $derived(hasInformativeInertTooltip ? tooltip : null);

	function stopParentContextTriggerGesture(event: PointerEvent | MouseEvent): void {
		event.stopPropagation();
	}
</script>

{#snippet idSuffix()}
	{INLINE_LABEL_SEPARATOR}<span class={idClass}>({chatId})</span>
{/snippet}

{#snippet label()}
	{#if customAuthoredLabel}
		{@render authoredLabel?.()}
		{#if !navigable}
			{@render idSuffix()}
		{/if}
	{:else if title}
		<span class={titleClass}>{title}</span>{@render idSuffix()}
	{:else}
		<span class={titleClass}>{chatId}</span>
	{/if}
{/snippet}

{#if navigable}
	<a
		href={`/chat/${chatId}`}
		class={cn(
			'rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
			className,
			linkClass,
		)}
		title={tooltip}
		data-chat-reference-id={chatId}
		onpointerdowncapture={stopParentContextTriggerGesture}
		oncontextmenu={stopParentContextTriggerGesture}
	>
		{@render label()}
	</a>
{:else}
	<span class={className} title={inertTooltip ?? undefined} data-chat-reference-id={chatId}>
		{@render label()}
	</span>
{/if}
