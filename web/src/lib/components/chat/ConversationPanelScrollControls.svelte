<script lang="ts">
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import { Button } from '$lib/components/ui/button';
	import type { ConversationPanelRegistration } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	let {
		panel,
		reserveMobileToolbar = false,
	}: {
		panel: ConversationPanelRegistration;
		reserveMobileToolbar?: boolean;
	} = $props();

	const topButtonClass = $derived(
		cn(
			'absolute right-5 z-20 size-11 rounded-full shadow-md hover:shadow-lg sm:right-6',
			reserveMobileToolbar ? 'top-16' : 'top-3',
		),
	);
</script>

{#if (panel.transcript.isUserScrolledUp || panel.scroll.isScrollingToBottom) && panel.transcript.displayMessageCount > 0}
	{#if panel.scroll.canScrollToTop && !panel.scroll.isScrollingToBottom}
		<Button
			variant="outline"
			size="icon"
			class={topButtonClass}
			onclick={() => panel.scroll.scrollToTop()}
			disabled={panel.scroll.isScrollingToTop}
			title={m.workspace_scroll_to_initial_prompt()}
		>
			{#if panel.scroll.isScrollingToTop}
				<Loader2 class="size-5 animate-spin" />
			{:else}
				<ArrowUp class="size-5" />
			{/if}
		</Button>
	{/if}
	<Button
		variant="outline"
		size="icon"
		class="absolute bottom-14 right-5 z-20 size-11 rounded-full shadow-md hover:shadow-lg sm:right-6"
		onclick={() => void panel.scroll.scrollToLatestAndFill()}
		disabled={panel.scroll.isScrollingToBottom}
		title={m.workspace_scroll_to_bottom()}
	>
		{#if panel.scroll.isScrollingToBottom}
			<Loader2 class="size-5 animate-spin" />
		{:else}
			<ArrowDown class="size-5" />
		{/if}
	</Button>
{/if}
