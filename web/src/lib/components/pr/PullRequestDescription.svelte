<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import Markdown from '$lib/components/rich-text/Markdown.svelte';

	// Shows the start of a long description in the scrolling body instead of hiding it behind a
	// disclosure; collapsing returns to the description so the reader is not left mid-page.
	let { body }: { body: string } = $props();

	const CLIPPED_HEIGHT_PX = 240;
	let expanded = $state(false);
	let contentHeight = $state(0);
	let section = $state<HTMLElement | null>(null);
	const clippable = $derived(contentHeight > CLIPPED_HEIGHT_PX);
	const clipped = $derived(clippable && !expanded);

	function toggle(): void {
		expanded = !expanded;
		if (!expanded) section?.scrollIntoView({ block: 'nearest' });
	}
</script>

{#if body.trim()}
	<section class="mt-3" bind:this={section} data-pr-description>
		<h3 class="mb-1 text-xs font-medium text-muted-foreground">{m.pull_request_description()}</h3>
		<div
			class="relative overflow-hidden"
			style:max-height={clipped ? `${CLIPPED_HEIGHT_PX}px` : undefined}
			data-pr-description-clipped={clipped}
		>
			<div bind:offsetHeight={contentHeight}>
				<!-- Description headings stay subordinate to the pull request title above them. -->
				<Markdown
					source={body}
					class="markdown-body prose prose-sm max-w-none text-sm prose-headings:mt-3 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-semibold"
				/>
			</div>
			{#if clipped}
				<div
					class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent"
					aria-hidden="true"
				></div>
			{/if}
		</div>
		{#if clippable}
			<button
				type="button"
				class="mt-1 rounded-sm text-xs font-medium text-interactive-accent hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:py-1.5"
				aria-expanded={expanded}
				onclick={toggle}
			>
				{expanded ? m.pull_request_show_less() : m.pull_request_show_more()}
			</button>
		{/if}
	</section>
{/if}
