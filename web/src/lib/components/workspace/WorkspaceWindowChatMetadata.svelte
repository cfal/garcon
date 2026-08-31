<script lang="ts">
	import { onDestroy } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import { formatCompactProjectPath } from '$lib/chat/project-paths/compact-project-path';
	import { DropdownMenuItem } from '$lib/components/ui/dropdown-menu';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as m from '$lib/paraglide/messages.js';

	type MetadataField = 'project-path' | 'chat-id';

	let { projectPath, chatId }: { projectPath: string; chatId: string } = $props();
	let displayProjectPath = $derived(formatCompactProjectPath(projectPath));
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

{#snippet metadataField(
	field: MetadataField,
	actionLabel: string,
	copiedLabel: string,
	value: string,
	displayValue: string,
)}
	{@const copied = copiedField === field}
	{@const feedbackLabel = copied ? copiedLabel : actionLabel}
	<DropdownMenuItem
		class="group items-start"
		closeOnSelect={false}
		textValue={actionLabel}
		title={feedbackLabel}
		aria-label={`${feedbackLabel}: ${value}`}
		data-workspace-chat-metadata-field={field}
		onSelect={() => void copyField(field, value)}
	>
		{#if copied}
			<Check class="mt-0.5 size-4 text-status-success-foreground" />
		{:else}
			<Copy class="mt-0.5 size-4" />
		{/if}
		<div class="min-w-0 flex-1">
			<div class="font-medium">{actionLabel}</div>
			<div
				class="truncate text-xs text-muted-foreground group-data-[highlighted]:text-accent-foreground"
				title={value}
				data-workspace-chat-metadata-value={field}
			>
				{displayValue}
			</div>
		</div>
	</DropdownMenuItem>
{/snippet}

{@render metadataField(
	'project-path',
	m.workspace_chat_metadata_copy_project_path(),
	m.workspace_chat_metadata_copied({ field: m.sidebar_details_project_path() }),
	projectPath,
	displayProjectPath,
)}
{@render metadataField(
	'chat-id',
	m.workspace_chat_metadata_copy_chat_id(),
	m.workspace_chat_metadata_copied({ field: m.sidebar_details_chat_id() }),
	chatId,
	chatId,
)}
