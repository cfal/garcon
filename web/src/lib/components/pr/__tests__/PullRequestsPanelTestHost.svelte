<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import {
		setWorkspaceCoordinator,
		setRemoteSettings,
		setNotifications,
		setTransientLayers,
	} from '$lib/context';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context.js';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import { NotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte';
	import PullRequestsPanel from '../PullRequestsPanel.svelte';

	let { props }: { props: ComponentProps<typeof PullRequestsPanel> } = $props();
	setExecutorsTestContext();
	setRemoteSettings(createRemoteSettingsStore());
	setNotifications(new NotificationsStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));

	setWorkspaceCoordinator({
		isSurfaceCloseBlocked: () => false,
		moveSurface: async () => undefined,
		closeSurface: async () => true,
	} as unknown as WorkspaceCoordinator);
</script>

<PullRequestsPanel {...props} />
