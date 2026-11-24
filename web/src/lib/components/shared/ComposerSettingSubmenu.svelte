<script lang="ts">
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import {
		DropdownMenuSub,
		DropdownMenuSubContent,
		DropdownMenuSubTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { getOptionalTransientLayers } from '$lib/context';
	import MenuValueLabel from './MenuValueLabel.svelte';

	let {
		id,
		name,
		label,
		value,
		disabled,
		align,
		side,
		icon,
		children,
		contentClass = '',
		onOpenChange,
		onOpenAutoFocus,
	}: {
		id: string;
		name: string;
		label: string;
		value: string;
		disabled: boolean;
		align: 'start' | 'end';
		side: 'top' | 'bottom';
		icon: Snippet;
		children: Snippet;
		contentClass?: string;
		onOpenChange?: (open: boolean) => void;
		onOpenAutoFocus?: (event: Event) => void;
	} = $props();
	const narrowViewport = new MediaQuery('(max-width: 640px)');
	const layers = getOptionalTransientLayers();
	const layerId = $props.id();
	let open = $state(false);
	let trigger = $state<HTMLElement | null>(null);
	let content = $state<HTMLElement | null>(null);

	function closeLevel(): boolean {
		open = false;
		return true;
	}

	function restoreFocus(): void {
		trigger?.focus({ preventScroll: true });
	}

	// Workspace Escape closes the innermost open level, not the entire toolbar menu.
	$effect(() => {
		if (!open || !content || !layers) return;
		return layers.register({
			id: layerId,
			kind: 'menu',
			modality: 'nonmodal',
			isOpen: () => open,
			element: () => content,
			onEscape: closeLevel,
			restoreFocus,
		});
	});
</script>

<DropdownMenuSub bind:open {onOpenChange}>
	<DropdownMenuSubTrigger
		bind:ref={trigger}
		{disabled}
		class="group"
		textValue={label}
		aria-label={name}
		data-composer-control={id}
	>
		{@render icon()}
		<MenuValueLabel {label} {value} />
	</DropdownMenuSubTrigger>
	<DropdownMenuSubContent
		bind:ref={content}
		{onOpenAutoFocus}
		side={narrowViewport.current ? side : 'right'}
		{align}
		collisionPadding={8}
		escapeKeydownBehavior="close"
		onEscapeKeydown={(event) => {
			event.preventDefault();
			closeLevel();
			restoreFocus();
		}}
		class="max-h-(--bits-dropdown-menu-content-available-height) max-w-[calc(100vw-1rem)] overflow-y-auto {contentClass}"
	>
		{@render children()}
	</DropdownMenuSubContent>
</DropdownMenuSub>
