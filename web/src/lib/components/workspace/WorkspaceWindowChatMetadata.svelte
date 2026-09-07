<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import { formatCompactProjectPath } from '$lib/chat/project-paths/compact-project-path';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import {
		dropdownMenuPrimitives,
		type MenuPrimitives,
	} from '$lib/components/ui/menu-primitives.js';
	import * as m from '$lib/paraglide/messages.js';

	type MetadataField = 'project-path' | 'chat-id';

	let {
		menu = dropdownMenuPrimitives,
		projectPath,
		chatId,
	}: {
		menu?: MenuPrimitives;
		projectPath: string;
		chatId: string;
	} = $props();
	let displayProjectPath = $derived(formatCompactProjectPath(projectPath));
</script>

{#snippet metadataField(
	field: MetadataField,
	actionLabel: string,
	value: string,
	displayValue: string,
)}
	<menu.Item
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
	</menu.Item>
{/snippet}

{@render metadataField(
	'project-path',
	m.workspace_chat_metadata_copy_project_path(),
	projectPath,
	displayProjectPath,
)}
{@render metadataField('chat-id', m.workspace_chat_metadata_copy_chat_id(), chatId, chatId)}
