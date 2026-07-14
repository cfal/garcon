<script lang="ts">
	import { Popover as PopoverPrimitive } from 'bits-ui';
	import PopoverPortal from './popover-portal.svelte';
	import { cn, type WithoutChildrenOrChild } from '$lib/utils/cn.js';
	import type { ComponentProps } from 'svelte';
	import { getOptionalTransientLayers } from '$lib/context';
	import { getTransientLayerControl } from '../transient-layer-context';
	import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id';

	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 4,
		align = 'center',
		portalProps,
		...restProps
	}: PopoverPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof PopoverPortal>>;
	} = $props();
	const transientLayers = getOptionalTransientLayers();
	const layerControl = getTransientLayerControl();
	const layerId = allocateTransientLayerId('popover');
	const focusReturnTarget =
		typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;

	$effect(() => {
		if (!transientLayers || !ref) return;
		return transientLayers.register({
			id: layerId,
			kind: 'popover',
			modality: 'nonmodal',
			element: () => ref,
			onEscape: () => {
				layerControl.close();
				return true;
			},
			restoreFocus: () => focusReturnTarget?.focus(),
		});
	});
</script>

<PopoverPortal {...portalProps}>
	<PopoverPrimitive.Content
		bind:ref
		data-slot="popover-content"
		{sideOffset}
		{align}
		class={cn(
			'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-end-2 data-[side=right]:slide-in-from-start-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--bits-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden',
			className,
		)}
		{...restProps}
	/>
</PopoverPortal>
