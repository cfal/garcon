<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		disclosure?: 'expanded' | 'collapsed';
		alwaysExpanded?: boolean;
		expanded?: boolean;
		onExpandedChange?: (expanded: boolean) => void;
		children: Snippet;
	}

	let {
		disclosure,
		alwaysExpanded = false,
		expanded,
		onExpandedChange,
		children,
	}: Props = $props();
	const OVERFLOW_TOLERANCE_PX = 1;
	let localExpanded = $state(false);
	let bodyElement = $state<HTMLDivElement>();
	let bodyWidth = $state(0);
	let contentHeight = $state(0);
	let hasOverflow = $state(false);
	let measuredCollapsedHeight: number | undefined;
	const bodyId = $props.id();
	const collapsible = $derived(disclosure === 'collapsed' && !alwaysExpanded);
	const expansionRequested = $derived(
		alwaysExpanded || !collapsible || (onExpandedChange ? (expanded ?? false) : localExpanded),
	);
	const bodyExpanded = $derived(expansionRequested && hasOverflow);
	const showDisclosure = $derived(collapsible && hasOverflow);

	function measureOverflow(
		element: HTMLDivElement,
		_bodyWidth: number,
		_contentHeight: number,
	): void {
		if (!collapsible) {
			hasOverflow = false;
			measuredCollapsedHeight = undefined;
			return;
		}

		const collapsedHeight = bodyExpanded
			? (measuredCollapsedHeight ?? element.clientHeight)
			: element.clientHeight;
		const nextHasOverflow = element.scrollHeight > collapsedHeight + OVERFLOW_TOLERANCE_PX;

		if (!bodyExpanded && nextHasOverflow) measuredCollapsedHeight = collapsedHeight;
		hasOverflow = nextHasOverflow;
		if (expansionRequested && !nextHasOverflow) updateExpanded(false);
	}

	function updateExpanded(next: boolean): void {
		if (onExpandedChange) onExpandedChange(next);
		else localExpanded = next;
	}

	function toggle(): void {
		updateExpanded(!bodyExpanded);
	}

	function expandOnFocus(): void {
		if (hasOverflow && !bodyExpanded) updateExpanded(true);
	}

	$effect(() => {
		if (!collapsible) {
			hasOverflow = false;
			measuredCollapsedHeight = undefined;
			return;
		}
		if (!bodyElement) return;
		// Dimension arguments register both ResizeObserver bindings as effect dependencies.
		measureOverflow(bodyElement, bodyWidth, contentHeight);
	});
</script>

{#if collapsible}
	<div
		id={bodyId}
		data-slot="collapsible-body"
		bind:this={bodyElement}
		bind:clientWidth={bodyWidth}
		class:collapsible-body-collapsed={!bodyExpanded}
		class:collapsible-body-truncated={showDisclosure && !bodyExpanded}
		onfocusin={expandOnFocus}
	>
		<div class="flow-root" data-slot="collapsible-body-content" bind:offsetHeight={contentHeight}>
			{@render children()}
		</div>
	</div>
	{#if showDisclosure}
		<button
			type="button"
			class="-mx-1 mt-1 inline-flex min-h-6 items-center rounded-sm px-1 text-xs font-medium text-inherit underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
			aria-expanded={bodyExpanded}
			aria-controls={bodyId}
			onclick={toggle}
		>
			{bodyExpanded ? m.chat_message_show_less() : m.chat_message_show_more()}
		</button>
	{/if}
{:else}
	{@render children()}
{/if}
