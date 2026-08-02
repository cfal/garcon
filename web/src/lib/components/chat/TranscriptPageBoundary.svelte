<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import type {
		TranscriptPageDirection,
		TranscriptPageState,
	} from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		direction: TranscriptPageDirection;
		pageState: TranscriptPageState;
		onRequest: () => void;
	}

	let { direction, pageState, onRequest }: Props = $props();
	const loading = $derived(pageState.status === 'loading');
	const failed = $derived(pageState.status === 'error');

	function request(): void {
		if (loading) return;
		onRequest();
	}

	function label(): string {
		if (loading) {
			return direction === 'earlier'
				? m.chat_transcript_loading_earlier()
				: m.chat_transcript_loading_later();
		}
		if (failed) {
			return direction === 'earlier'
				? m.chat_transcript_retry_earlier()
				: m.chat_transcript_retry_later();
		}
		return direction === 'earlier'
			? m.chat_transcript_load_earlier()
			: m.chat_transcript_load_later();
	}
</script>

<div
	class="flex h-9 items-center gap-2 py-1 text-xs text-muted-foreground"
	data-transcript-page-boundary={direction}
>
	<div class="h-px flex-1 bg-border/70"></div>
	<Button
		type="button"
		variant="ghost"
		size="sm"
		class="h-7 gap-1.5 whitespace-nowrap px-2 text-xs"
		aria-disabled={loading}
		aria-busy={loading}
		onclick={request}
	>
		{#if loading}
			<Loader2 class="size-3.5 animate-spin" />
		{:else if failed}
			<RefreshCw class="size-3.5" />
		{:else if direction === 'earlier'}
			<ChevronUp class="size-3.5" />
		{:else}
			<ChevronDown class="size-3.5" />
		{/if}
		<span role="status" aria-live="polite" aria-atomic="true">{label()}</span>
	</Button>
	<div class="h-px flex-1 bg-border/70"></div>
</div>
