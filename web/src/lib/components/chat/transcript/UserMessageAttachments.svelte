<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import { isImageAttachmentMimeType } from '@garcon/common/attachments';
	import type { ChatImage } from '$shared/chat-types';

	let { attachments }: { attachments: ChatImage[] } = $props();

	function isImageAttachment({ data, mimeType }: ChatImage): boolean {
		return isImageAttachmentMimeType(mimeType || data.match(/^data:([^;]+);base64,/)?.[1] || '');
	}
</script>

{#if attachments.length > 0}
	<div class="mt-2 grid grid-cols-2 gap-2">
		{#each attachments as attachment, index (index)}
			{#if isImageAttachment(attachment)}
				<img src={attachment.data} alt={attachment.name} class="rounded-lg max-w-full h-auto" />
			{:else}
				<div class="user-message-attachment flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background/70 px-2 py-1.5 text-foreground">
					<FileText class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<span class="truncate text-xs">{attachment.name}</span>
				</div>
			{/if}
		{/each}
	</div>
{/if}
