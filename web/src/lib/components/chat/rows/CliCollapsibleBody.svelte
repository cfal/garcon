<script lang="ts">
	import type { CliBodyDisclosure } from '$shared/cli-presentation';
	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		disclosure?: CliBodyDisclosure;
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
	let localExpanded = $state(false);
	const bodyId = $props.id();
	const collapsible = $derived(disclosure === 'collapsed' && !alwaysExpanded);
	const bodyExpanded = $derived(
		alwaysExpanded ||
			!collapsible ||
			(onExpandedChange ? (expanded ?? false) : localExpanded),
	);

	function updateExpanded(next: boolean): void {
		if (onExpandedChange) onExpandedChange(next);
		else localExpanded = next;
	}

	function toggle(): void {
		updateExpanded(!bodyExpanded);
	}

	function expandOnFocus(): void {
		if (!bodyExpanded) updateExpanded(true);
	}
</script>

{#if collapsible}
	<div
		id={bodyId}
		class:cli-collapsible-body-collapsed={!bodyExpanded}
		onfocusin={expandOnFocus}
	>
		{@render children()}
	</div>
	<button
		type="button"
		class="mt-1 rounded-sm text-xs font-medium text-inherit underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
		aria-expanded={bodyExpanded}
		aria-controls={bodyId}
		onclick={toggle}
	>
		{bodyExpanded ? m.chat_message_show_less() : m.chat_message_show_more()}
	</button>
{:else}
	{@render children()}
{/if}
