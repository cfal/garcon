<script lang="ts">
	// Expandable card display for edit/write/search tools.
	// Uses ChatEventCard with a disclosure toggle in the header.

	import type { Snippet } from 'svelte';
	import ChatEventCard from '../rows/ChatEventCard.svelte';

	interface CollapsibleDisplayProps {
		toolName: string;
		toolId?: string;
		title: string;
		defaultOpen?: boolean;
		onTitleClick?: () => void;
		children: Snippet;
		class?: string;
	}

	let {
		toolName,
		toolId,
		title,
		defaultOpen = false,
		onTitleClick,
		children,
		class: className = ''
	}: CollapsibleDisplayProps = $props();

	let userToggled = $state(false);
	let localOpen = $state(false);
	let isOpen = $derived(userToggled ? localOpen : defaultOpen);

	function handleToggle() {
		userToggled = true;
		localOpen = !isOpen;
	}
</script>

{#snippet chevronSvg()}
	<svg
		class="w-3 h-3 text-muted-foreground transition-transform duration-150 flex-shrink-0 {isOpen ? 'rotate-90' : ''}"
		fill="none"
		stroke="currentColor"
		viewBox="0 0 24 24"
	>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width="2"
			d="M9 5l7 7-7 7"
		/>
	</svg>
{/snippet}

<div class="my-1 {className}">
	<ChatEventCard variant="default" compact>
		{#snippet header()}
			{#if onTitleClick}
				<!-- Whole row toggles expand; title text opens file as a separate focusable action -->
				<div
					class="flex w-full items-center gap-1.5 cursor-pointer"
					role="button"
					tabindex={-1}
					onclick={handleToggle}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggle(); } }}
				>
						{#if toolName}
							<span class="text-[11px] font-medium text-muted-foreground tracking-wide flex-shrink-0">
								{toolName}
							</span>
						{/if}
						<button
							type="button"
							class="text-primary hover:text-primary/80 font-mono hover:underline truncate text-left transition-colors text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
						onclick={(e) => { e.stopPropagation(); onTitleClick?.(); }}
					>
						{title}
					</button>
					<span class="flex-1"></span>
					{@render chevronSvg()}
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

		{#snippet body()}
			{#if isOpen}
				<div id={toolId ? `tool-body-${toolId}` : undefined} class="pt-1.5">
					{@render children()}
				</div>
			{/if}
		{/snippet}
	</ChatEventCard>
</div>
