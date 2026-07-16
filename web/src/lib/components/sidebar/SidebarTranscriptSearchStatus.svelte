<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils/cn.js';
	import type { ChatSearchIndexStatus } from '$shared/chat-search';

	interface SidebarTranscriptSearchStatusProps {
		enabled: boolean;
		loading?: boolean;
		indexing?: boolean;
		index?: ChatSearchIndexStatus | null;
		error?: string | null;
		onRetry?: () => void;
	}

	let {
		enabled,
		loading = false,
		indexing = false,
		index = null,
		error = null,
		onRetry = () => {},
	}: SidebarTranscriptSearchStatusProps = $props();

	let statusText = $derived.by(() => {
		if (loading) return m.sidebar_search_transcript_searching();
		if (indexing && index && index.pendingChatCount > 0) {
			return m.sidebar_search_transcript_indexing_progress({
				indexed: index.indexedChatCount,
				pending: index.pendingChatCount,
			});
		}
		if (indexing) return m.sidebar_search_transcript_indexing();
		if (index) {
			return index.indexedChatCount === 1
				? m.sidebar_search_transcript_ready_indexed_singular()
				: m.sidebar_search_transcript_ready_indexed_plural({ count: index.indexedChatCount });
		}
		return m.sidebar_search_transcript_ready();
	});
	let failedText = $derived(
		index && index.failedChatCount > 0
			? index.failedChatCount === 1
				? m.sidebar_search_transcript_failed_singular()
				: m.sidebar_search_transcript_failed_plural({ count: index.failedChatCount })
			: '',
	);
	let unsupportedText = $derived(
		index && index.unsupportedChatCount > 0
			? index.unsupportedChatCount === 1
				? m.sidebar_search_transcript_unsupported_singular()
				: m.sidebar_search_transcript_unsupported_plural({ count: index.unsupportedChatCount })
			: '',
	);
	let fullStatusText = $derived(
		[statusText, failedText, unsupportedText].filter(Boolean).join(' '),
	);
</script>

{#if enabled}
	<div
		class={cn(
			'flex h-8 shrink-0 items-center border-b border-border bg-chat-thinking px-4 text-xs',
			error
				? 'justify-between gap-3 text-destructive'
				: 'text-muted-foreground',
		)}
		data-slot="transcript-search-status"
		role={error ? 'alert' : 'status'}
		aria-live={error ? 'assertive' : 'polite'}
	>
		{#if error}
			<span class="min-w-0 truncate" title={error}>{error}</span>
			<Button variant="outline" size="sm" class="h-7" onclick={onRetry}>
				{m.common_retry()}
			</Button>
		{:else}
			<span class="min-w-0 truncate" title={fullStatusText}>
				<span>{statusText}</span>
				{#if failedText}
					<span> {failedText}</span>
				{/if}
				{#if unsupportedText}
					<span> {unsupportedText}</span>
				{/if}
			</span>
		{/if}
	</div>
{/if}
