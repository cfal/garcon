<script lang="ts">
	import SnippetFormDialog from '../SnippetFormDialog.svelte';
	import { setNotifications, setSnippets, setTransientLayers } from '$lib/context';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { NotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import type { SnippetDefinitionInput } from '$shared/snippets';
	let {
		initialTemplate,
		onSave,
		onClose,
	}: {
		initialTemplate: string;
		onSave: (definition: SnippetDefinitionInput) => Promise<void>;
		onClose: () => void;
	} = $props();
	setSnippets(createSnippetsStore());
	setNotifications(new NotificationsStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<SnippetFormDialog open={true} snippet={null} {initialTemplate} {onSave} {onClose} />
