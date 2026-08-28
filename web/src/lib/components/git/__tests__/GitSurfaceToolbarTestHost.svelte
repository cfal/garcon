<script lang="ts">
	import type { PaneId } from '$lib/workspace/surface-types.js';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitSurfaceToolbar from '../GitSurfaceToolbar.svelte';
	import type { GitTargetSessionController } from '$lib/git/targets/git-target-session.svelte.js';
	import type { ResponsiveSurfaceAction } from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import { setRemoteSettings, setTransientLayers } from '$lib/context';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';

	let {
		target,
		presentation,
		onClose,
		closeDisabled = false,
		showMenuLeadingContent = false,
	}: {
		target: GitTargetSessionController;
		presentation: PaneId | 'mobile';
		onClose?: () => void;
		closeDisabled?: boolean;
		showMenuLeadingContent?: boolean;
	} = $props();

	setRemoteSettings(createRemoteSettingsStore());
	setTransientLayers(new TransientLayerRegistry(new ChatInteractionGate()));

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
