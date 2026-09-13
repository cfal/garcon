<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { setNotifications, setTransientLayers } from '$lib/context';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import IssueCommentComposer from '../IssueCommentComposer.svelte';
	let props: ComponentProps<typeof IssueCommentComposer> = $props();
	setNotifications(createNotificationsStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<IssueCommentComposer {...props} />
