<script lang="ts">
	import { formatCompactProjectPath } from '$lib/chat/project-paths/compact-project-path';
	import WorkspaceWindowCopyItem from './WorkspaceWindowCopyItem.svelte';
	import {
		dropdownMenuPrimitives,
		type MenuPrimitives,
	} from '$lib/components/ui/menu-primitives.js';
	import * as m from '$lib/paraglide/messages.js';

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

<WorkspaceWindowCopyItem
	{menu}
	label={m.workspace_chat_metadata_copy_project_path()}
	value={projectPath}
	displayValue={displayProjectPath}
/>
<WorkspaceWindowCopyItem {menu} label={m.workspace_chat_metadata_copy_chat_id()} value={chatId} />
