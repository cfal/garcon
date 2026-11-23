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
	import * as m from '$lib/paraglide/messages.js';

	let {
		agent,
		model,
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
	let menuOpen = $state(false);
	let afterClose: (() => void) | undefined;
	export function standaloneAnchor(): HTMLElement | null {
		return toolbarDisplay === undefined && display === 'overflow' ? menuTrigger : null;
	}
	function closeMenu(next: () => void): void {
		afterClose = next;
		menuOpen = false;
	}
	$effect.pre(() => {
		if (toolbarDisplay !== undefined) return;
		const folded = display === 'overflow';
		if (!folded && menuOpen) {
			closeMenu(() => triggerNode?.focus({ preventScroll: true }));
			return;
		}
		const previous = document.activeElement;
		const target =
			folded && previous === triggerNode
				? menuTrigger
				: !folded && previous === menuTrigger
					? triggerNode
					: null;
		if (target)
			void tick().then(() => {
				if (document.activeElement === previous || document.activeElement === document.body)
					target.focus({ preventScroll: true });
			});
	});
</script>

<div
	class={toolbarDisplay === undefined
		? 'relative inline-grid w-max min-w-0 max-w-full grid-cols-[minmax(0,1fr)]'
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
		<DropdownMenu
			bind:open={menuOpen}
			onOpenChange={(open) => {
				if (open) {
					afterClose = undefined;
					dismissPicker();
				}
			}}
		>
			<DropdownMenuTrigger
				bind:ref={menuTrigger}
				hidden={display !== 'overflow'}
				{disabled}
				data-slot="model-selector-overflow"
				aria-label={m.chat_composer_more_settings()}
				title={m.chat_composer_more_settings()}
				class="col-start-1 row-start-1 inline-flex size-9 items-center justify-center justify-self-start rounded-lg border border-border bg-background hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				><Ellipsis class="size-4" /></DropdownMenuTrigger
			>
			<DropdownMenuContent
				{align}
				{side}
				collisionPadding={8}
				class="w-64 max-w-[calc(100vw-1rem)]"
				getFocusReturnTarget={() => standaloneAnchor() ?? triggerNode}
				onCloseAutoFocus={(event) => {
					if (!afterClose) return;
					event.preventDefault();
					queueMicrotask(afterClose);
					afterClose = undefined;
				}}
			>
				<ModelSelectorMenuItem
					{disabled}
					summary={[agent, model].filter(Boolean).join(' / ')}
					onSelect={() => closeMenu(openPicker)}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	{/if}
</div>
