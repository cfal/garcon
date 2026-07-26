<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import CommitSurface from '../CommitSurface.svelte';
	import {
		setRemoteSettings,
		setTransientLayers,
		setWorkspaceCoordinator,
	} from '$lib/context';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';

	let props: ComponentProps<typeof CommitSurface> = $props();
	setRemoteSettings(createRemoteSettingsStore());
	setTransientLayers(new TransientLayerRegistry(new ChatInteractionGate()));
	setWorkspaceCoordinator({
		moveSurface: () => Promise.resolve(),
		closeSurface: () => Promise.resolve(true),
		isSurfaceCloseBlocked: () => false,
	} as never);
</script>

<CommitSurface {...props} />
