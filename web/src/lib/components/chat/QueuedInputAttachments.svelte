<script lang="ts">
	import type { QueueEntryAttachment } from '$lib/types/chat';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import FileText from '@lucide/svelte/icons/file-text';
	import ImageIcon from '@lucide/svelte/icons/image';

	interface Props {
		attachments: readonly QueueEntryAttachment[];
		class?: string;
	}

	let { attachments, class: className }: Props = $props();
</script>

{#if attachments.length > 0}
	<ul
		class={cn('flex flex-wrap gap-1.5', className)}
		aria-label={m.chat_queue_attachments({ count: attachments.length })}
		data-queue-attachments
	>
		{#each attachments as attachment, index (index)}
			<li
				class="flex min-w-0 max-w-48 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
				title={attachment.name}
			>
				{#if attachment.mimeType.startsWith('image/')}
					<ImageIcon class="size-3.5 shrink-0" aria-hidden="true" />
				{:else}
					<FileText class="size-3.5 shrink-0" aria-hidden="true" />
				{/if}
				<span class="truncate">{attachment.name}</span>
			</li>
		{/each}
	</ul>
{/if}
