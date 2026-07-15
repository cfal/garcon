<script lang="ts">
	import { CircleAlert, Info, LoaderCircle } from '@lucide/svelte';
	import type { LocalNoticeRow as LocalNotice } from '$lib/chat/transcript/local-notice.js';
	import ChatEventCard from './ChatEventCard.svelte';

	type ChatEventCardVariant = 'info' | 'warning' | 'error' | 'neutral';

	interface Props {
		notice: LocalNotice;
	}

	let { notice }: Props = $props();

	const cardVariant = $derived.by((): ChatEventCardVariant => {
		switch (notice.noticeType) {
			case 'progress':
				return 'info';
			case 'warning':
				return 'warning';
			case 'error':
				return 'error';
			case 'info':
			default:
				return 'neutral';
		}
	});
</script>

<ChatEventCard variant={cardVariant} compact>
	{#snippet body()}
		<div class="flex min-w-0 items-center gap-2 text-xs font-medium">
			{#if notice.noticeType === 'progress'}
				<LoaderCircle class="size-3.5 shrink-0 animate-spin" />
			{:else if notice.noticeType === 'error' || notice.noticeType === 'warning'}
				<CircleAlert class="size-3.5 shrink-0" />
			{:else}
				<Info class="size-3.5 shrink-0" />
			{/if}
			<span class="min-w-0 break-words">{notice.content}</span>
		</div>
	{/snippet}
</ChatEventCard>
