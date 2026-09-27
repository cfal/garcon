<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import FileVideo from '@lucide/svelte/icons/file-video';
	import X from '@lucide/svelte/icons/x';
	import {
		isImageAttachment,
		isVideoChatAttachment,
	} from '$lib/chat/composer/image-attachment.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		files,
		previewUrls,
		disabled,
		class: className,
		onRemove,
	}: {
		files: File[];
		previewUrls: ReadonlyMap<File, string>;
		disabled: boolean;
		class: string;
		onRemove: (index: number) => void;
	} = $props();
</script>

{#if files.length > 0}
	<div class={className}>
		<div class="flex flex-wrap gap-2">
			{#each files as file, idx (file.name + idx)}
				<div class="relative group">
					<div class="w-16 h-16 rounded-lg overflow-hidden border border-border">
						{#if isImageAttachment(file)}
							{@const url = previewUrls.get(file)}
							{#if url}
								<img src={url} alt={file.name} class="w-full h-full object-cover" />
							{/if}
						{:else}
							<div
								class="flex h-full w-full flex-col items-center justify-center gap-1 bg-background px-1 text-muted-foreground"
							>
								{#if isVideoChatAttachment(file)}
									<FileVideo class="h-5 w-5" aria-hidden="true" />
								{:else}
									<FileText class="h-5 w-5" aria-hidden="true" />
								{/if}
								<span class="w-full truncate text-center text-[10px] leading-tight"
									>{file.name}</span
								>
							</div>
						{/if}
					</div>
					<button
						type="button"
						aria-label={m.chat_composer_remove_image({ name: file.name })}
						title={m.chat_composer_remove_image({ name: file.name })}
						class="absolute -top-1 -right-1 w-5 h-5 bg-destructive text-destructive-foreground rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
						onclick={() => {
							if (!disabled) onRemove(idx);
						}}
						{disabled}
					>
						<X class="w-3 h-3" aria-hidden="true" />
					</button>
				</div>
			{/each}
		</div>
	</div>
{/if}
