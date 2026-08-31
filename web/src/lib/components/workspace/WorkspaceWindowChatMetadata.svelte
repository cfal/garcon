<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import { formatCompactProjectPath } from '$lib/chat/project-paths/compact-project-path';
	import { DropdownMenuItem } from '$lib/components/ui/dropdown-menu';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as m from '$lib/paraglide/messages.js';

	type MetadataField = 'project-path' | 'chat-id';

	let { projectPath, chatId }: { projectPath: string; chatId: string } = $props();
	let displayProjectPath = $derived(formatCompactProjectPath(projectPath));
</script>

{#snippet metadataField(
	field: MetadataField,
	actionLabel: string,
	value: string,
	displayValue: string,
)}
	<DropdownMenuItem
		class="group items-start"
		textValue={actionLabel}
		aria-label={`${actionLabel}: ${value}`}
		data-workspace-chat-metadata-field={field}
		onSelect={() => void copyToClipboard(value)}
	>
		<Copy class="mt-0.5 size-4" />
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
	projectPath,
	displayProjectPath,
)}
{@render metadataField(
	'chat-id',
	m.workspace_chat_metadata_copy_chat_id(),
	chatId,
	chatId,
)}
