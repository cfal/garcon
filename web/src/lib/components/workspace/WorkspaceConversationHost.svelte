<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fromAction } from 'svelte/attachments';
	import { getSurfaceFrames, getWorkspaceCoordinator } from '$lib/context';
	import { surfaceFrame } from '$lib/workspace/surface-frame-action.js';
	import type { PresentationHostId } from '$lib/workspace/surface-types.js';
	import { cn } from '$lib/utils/cn';

	let {
		surfaceId,
		fallbackSurfaceId,
		host,
		visible,
		style,
		topPx,
		leftSeparator,
		rightSeparator,
		children,
	}: {
		surfaceId?: string;
		fallbackSurfaceId: string;
		host: PresentationHostId | null;
		visible: boolean;
		style: string;
		topPx?: number;
		leftSeparator: boolean;
		rightSeparator: boolean;
		children: Snippet;
	} = $props();
	const workspace = getWorkspaceCoordinator();
	const registry = getSurfaceFrames();
	const attachFrame = fromAction(surfaceFrame, () => ({
		registry,
		surfaceId: surfaceId ?? fallbackSurfaceId,
		host,
		version: 0,
	}));

	function noteFocus(): void {
		if (surfaceId) workspace.noteSurfaceFocus(surfaceId);
	}
</script>

<div
	class="pointer-events-none absolute z-30 overflow-hidden"
	class:invisible={!visible}
	{style}
	aria-hidden={!visible}
	inert={!visible}
>
	<div
		class={cn(
			'pointer-events-none absolute overflow-visible',
			topPx === undefined ? 'inset-0' : 'inset-x-0 bottom-0',
			leftSeparator && 'any-pointer-coarse:ml-3',
			rightSeparator && 'any-pointer-coarse:mr-3',
		)}
		style:top={topPx === undefined ? undefined : `${topPx}px`}
		data-workspace-live-chat-body
		data-workspace-live-chat-body-top-px={topPx}
		data-workspace-surface-id={surfaceId}
		onpointerdowncapture={noteFocus}
		onfocusincapture={noteFocus}
		{@attach attachFrame}
	>
		{@render children()}
	</div>
</div>
