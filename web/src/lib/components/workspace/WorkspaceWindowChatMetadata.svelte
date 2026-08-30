<script lang="ts">
	import { onDestroy } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import {
		DropdownMenuItem,
		DropdownMenuSeparator,
	} from '$lib/components/ui/dropdown-menu';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as m from '$lib/paraglide/messages.js';

	type MetadataField = 'project-path' | 'chat-id';

	let { projectPath, chatId }: { projectPath: string; chatId: string } = $props();
	let copiedField = $state<MetadataField | null>(null);
	let resetTimer: ReturnType<typeof setTimeout> | null = null;
	let copyGeneration = 0;

	async function copyField(field: MetadataField, value: string): Promise<void> {
		const generation = ++copyGeneration;
		if (!(await copyToClipboard(value)) || generation !== copyGeneration) return;
		copiedField = field;
		if (resetTimer) clearTimeout(resetTimer);
		resetTimer = setTimeout(() => {
			copiedField = null;
			resetTimer = null;
		}, 2000);
	}

	onDestroy(() => {
		copyGeneration++;
		if (resetTimer) clearTimeout(resetTimer);
	});
</script>

{#snippet metadataField(field: MetadataField, label: string, value: string)}
	{@const copied = copiedField === field}
	{@const actionLabel = copied
		? m.workspace_chat_metadata_copied({ field: label })
		: m.workspace_chat_metadata_copy({ field: label })}
	<DropdownMenuItem
		class="group flex-col items-stretch gap-1.5 rounded-md px-2 py-2"
		closeOnSelect={false}
		textValue={label}
		title={actionLabel}
		aria-label={`${actionLabel}: ${value}`}
		data-workspace-chat-metadata-field={field}
		onSelect={() => void copyField(field, value)}
	>
		<div class="flex w-full min-w-0 items-center justify-between gap-2">
			<span class="text-[11px] font-medium tracking-wide text-muted-foreground">{label}</span>
			<span
				class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors group-data-[highlighted]:bg-background/80 group-data-[highlighted]:text-foreground"
				class:text-status-success-foreground={copied}
				aria-hidden="true"
			>
				{#if copied}
					<Check class="size-3.5" />
				{:else}
					<Copy class="size-3.5" />
				{/if}
			</span>
		</div>
		<span
			class="block w-full min-w-0 break-all rounded-md border border-border/60 bg-muted/50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground"
		>
			{value}
		</span>
	</DropdownMenuItem>
{/snippet}

<div
	class="mx-0.5 rounded-lg border border-border/70 bg-muted/30 p-1 shadow-sm"
	data-workspace-chat-metadata
>
	{@render metadataField('project-path', m.sidebar_details_project_path(), projectPath)}
	{@render metadataField('chat-id', m.sidebar_details_chat_id(), chatId)}
</div>
<DropdownMenuSeparator class="my-1.5" data-workspace-chat-metadata-separator />
