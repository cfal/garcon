<script lang="ts">
	// Expandable card display for edit/write/search tools.
	// Uses ChatEventCard with a disclosure toggle in the header.

	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import ChatEventCard from '../rows/ChatEventCard.svelte';

	interface CollapsibleDisplayProps {
		toolName: string;
		toolId?: string;
		title: string;
		defaultOpen?: boolean;
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		onTitleClick?: () => void;
		children: Snippet;
		class?: string;
	}

	let {
		toolName,
		toolId,
		title,
		defaultOpen = false,
		open,
		onOpenChange,
		onTitleClick,
		children,
		class: className = '',
	}: CollapsibleDisplayProps = $props();

	let userToggled = $state(false);
	let localOpen = $state(false);
	let isOpen = $derived(open ?? (userToggled ? localOpen : defaultOpen));

	function handleToggle() {
		const next = !isOpen;
		if (onOpenChange) onOpenChange(next);
		else {
			userToggled = true;
			localOpen = next;
		}
	}
</script>

{#snippet chevronSvg()}
	<svg
		class="w-3 h-3 text-muted-foreground transition-transform duration-150 flex-shrink-0 {isOpen
			? 'rotate-90'
			: ''}"
		fill="none"
		stroke="currentColor"
		viewBox="0 0 24 24"
	>
		<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
	</svg>
{/snippet}

{#snippet rowHeader()}
	{#if onTitleClick}
		<!-- The overlay button spans the header so the whole row toggles while the file-title
		button above it keeps its own action; nested buttons forbid wrapping the row in one. -->
		<div class="relative flex w-full items-center gap-1.5">
			<button
				type="button"
				class="absolute inset-0 z-0 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				onclick={handleToggle}
				aria-expanded={isOpen}
				aria-controls={toolId ? `tool-body-${toolId}` : undefined}
				aria-label={isOpen ? m.editor_actions_collapse() : m.editor_actions_expand()}
			></button>
			{#if toolName}
				<span class="pointer-events-none z-10 text-[11px] font-medium text-muted-foreground tracking-wide flex-shrink-0">
					{toolName}
				</span>
			{/if}
			<button
				type="button"
				class="relative z-10 text-primary hover:text-primary/80 font-mono hover:underline truncate text-left transition-colors text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
				onclick={(e) => {
					e.stopPropagation();
					onTitleClick?.();
				}}
			>
				{title}
			</button>
			<span class="pointer-events-none z-10 flex-1"></span>
			<span class="pointer-events-none z-10 flex size-4 shrink-0 items-center justify-center">
				{@render chevronSvg()}
			</span>
		</div>
	{:else}
		<button
			type="button"
			class="flex w-full items-center gap-1.5 text-left"
			onclick={handleToggle}
			aria-expanded={isOpen}
			aria-controls={toolId ? `tool-body-${toolId}` : undefined}
		>
			{#if toolName}
				<span class="text-[11px] font-medium text-muted-foreground tracking-wide flex-shrink-0">
					{toolName}
				</span>
			{/if}
			<span class="text-foreground/85 truncate flex-1 text-xs">
				{title}
			</span>
			{@render chevronSvg()}
		</button>
	{/if}
{/snippet}

{#snippet rowBody()}
	<div id={toolId ? `tool-body-${toolId}` : undefined} class="pt-1.5">
		{@render children()}
	</div>
{/snippet}

<div class="my-0.5 {className}">
	<ChatEventCard variant="default" compact header={rowHeader} body={isOpen ? rowBody : undefined} />
</div>
