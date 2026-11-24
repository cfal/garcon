<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import {
		fitModelTrigger,
		type ModelTriggerDisplay,
		type ModelTriggerWidths,
	} from '$lib/agents/model-trigger-fit';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import ModelSelectorMenuItem from './ModelSelectorMenuItem.svelte';
	import { OverflowMenuState } from '$lib/components/shared/overflow-menu-state.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		agent,
		model,
		menuSelection,
		buttonClass,
		toolbarDisplay,
		onMeasure,
		triggerNode,
		disabled,
		side,
		align,
		openPicker,
		dismissPicker,
		children,
	}: {
		agent: string;
		model: string;
		menuSelection: { summary: string; title: string };
		buttonClass: string;
		toolbarDisplay?: ModelTriggerDisplay;
		onMeasure?: (widths: ModelTriggerWidths) => void;
		triggerNode: HTMLElement | null;
		disabled: boolean;
		side: 'top' | 'right' | 'bottom' | 'left';
		align: 'start' | 'center' | 'end';
		openPicker: () => void;
		dismissPicker: () => void;
		children: Snippet<[label: string, hidden: boolean]>;
	} = $props();

	const combined = $derived(
		[agent, model].filter(Boolean).join(' ') || m.model_selector_unavailable(),
	);
	const modelOnly = $derived(model || combined);
	let combinedBox = $state<readonly ResizeObserverSize[]>();
	let modelBox = $state<readonly ResizeObserverSize[]>();
	let available = $state<DOMRectReadOnly>();
	const widths = $derived(
		combinedBox?.[0]?.inlineSize && modelBox?.[0]?.inlineSize
			? { combined: combinedBox[0].inlineSize, model: modelBox[0].inlineSize }
			: undefined,
	);
	$effect(() => {
		if (widths) onMeasure?.(widths);
	});
	const display = $derived(
		toolbarDisplay ??
			(widths && available ? fitModelTrigger(widths, available.width) : 'combined'),
	);

	let menuTrigger = $state<HTMLElement | null>(null);
	const menu = new OverflowMenuState(() => dismissPicker());
	export function standaloneAnchor(): HTMLElement | null {
		return toolbarDisplay === undefined && display === 'overflow' ? menuTrigger : null;
	}
	$effect.pre(() => {
		if (toolbarDisplay !== undefined) return;
		const folded = display === 'overflow';
		if (!folded && menu.open) {
			menu.closeThen(() => triggerNode?.focus({ preventScroll: true }));
			return;
		}
		const previous = document.activeElement;
		if (previous !== (folded ? triggerNode : menuTrigger)) return;
		const target = folded ? menuTrigger : triggerNode;
		if (!target) return;
		void tick().then(() => {
			if (document.activeElement === previous || document.activeElement === document.body)
				target.focus({ preventScroll: true });
		});
	});
</script>

<div
	class={toolbarDisplay === undefined
		? 'relative inline-grid w-max min-w-0 max-w-full grid-cols-[minmax(0,1fr)] [justify-items:var(--model-trigger-justify,start)]'
		: 'contents'}
	bind:contentRect={available}
>
	<!-- Intrinsic button widths stay measurable even when the real trigger is folded. -->
	<div
		aria-hidden="true"
		inert
		class="pointer-events-none invisible flex h-0 min-w-0 flex-col items-start overflow-hidden {toolbarDisplay ===
		undefined
			? 'col-start-1 row-start-1'
			: 'absolute w-0'}"
	>
		<span class="{buttonClass} w-max shrink-0" bind:borderBoxSize={combinedBox}>{combined}</span>
		<span class="{buttonClass} w-max shrink-0" bind:borderBoxSize={modelBox}>{modelOnly}</span>
	</div>
	{@render children(display === 'combined' ? combined : modelOnly, display === 'overflow')}
	{#if toolbarDisplay === undefined}
		<DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
			<DropdownMenuTrigger
				bind:ref={menuTrigger}
				hidden={display !== 'overflow'}
				{disabled}
				data-slot="model-selector-overflow"
				aria-label={m.chat_composer_more_settings()}
				title={m.chat_composer_more_settings()}
				class="col-start-1 row-start-1 inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				><Ellipsis class="size-4" /></DropdownMenuTrigger
			>
			<DropdownMenuContent
				{align}
				{side}
				collisionPadding={8}
				class="w-64 max-w-[calc(100vw-1rem)]"
				getFocusReturnTarget={() => standaloneAnchor() ?? triggerNode}
				onCloseAutoFocus={menu.onCloseAutoFocus}
			>
				<ModelSelectorMenuItem
					{disabled}
					selection={menuSelection}
					onSelect={() => menu.closeThen(openPicker)}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	{/if}
</div>
