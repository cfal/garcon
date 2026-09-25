<script lang="ts">
	import { untrack } from 'svelte';
	import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context.js';
	import type { ExecutorSnapshot } from '$shared/executors';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitSurfaceToolbar from '../GitSurfaceToolbar.svelte';
	import type { GitTargetSessionController } from '$lib/git/targets/git-target-session.svelte.js';
	import type { ResponsiveSurfaceAction } from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import { setNotifications, setRemoteSettings, setTransientLayers } from '$lib/context';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import { NotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';

	let {
		target,
		presentation,
		onClose,
		closeDisabled = false,
		showMenuLeadingContent = false,
		executors,
	}: {
		target: GitTargetSessionController;
		presentation: WorkspaceWindowId | 'mobile';
		onClose?: () => void;
		closeDisabled?: boolean;
		showMenuLeadingContent?: boolean;
		executors?: readonly ExecutorSnapshot[];
	} = $props();

	setExecutorsTestContext(untrack(() => executors));
	setNotifications(new NotificationsStore());
	setRemoteSettings(createRemoteSettingsStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));

	const actions: ResponsiveSurfaceAction[] = [
		{
			id: 'refresh',
			label: 'Refresh',
			icon: RefreshCw,
			onclick: () => undefined,
			priority: 0,
		},
	];
</script>

{#snippet menuLeadingContent()}
	<span data-test-diff-settings>Diff settings</span>
{/snippet}

<GitSurfaceToolbar
	{target}
	{presentation}
	{actions}
	{onClose}
	{closeDisabled}
	menuLeadingContent={showMenuLeadingContent ? menuLeadingContent : undefined}
/>
