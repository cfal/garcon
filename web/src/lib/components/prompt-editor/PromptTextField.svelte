<script lang="ts">
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Square from '@lucide/svelte/icons/square';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		id: string;
		ref?: HTMLTextAreaElement | null;
		value?: string;
		placeholder?: string;
		invalid: boolean;
		readOnly: boolean;
		disabled?: boolean;
		rows?: number;
		textareaClass?: string;
		describedBy?: string;
		canExpand: boolean;
		expandLabel: string;
		canRefinePrompt: boolean;
		isPromptRefinementPending: boolean;
		onkeydown?: (event: KeyboardEvent) => void;
		onExpand: () => void;
		onRefinePrompt: () => void;
	}

	let {
		id,
		ref = $bindable(null),
		value = $bindable(''),
		placeholder = '',
		invalid,
		readOnly,
		disabled = false,
		rows = 4,
		textareaClass = '',
		describedBy = '',
		canExpand,
		expandLabel,
		canRefinePrompt,
		isPromptRefinementPending,
		onkeydown,
		onExpand,
		onRefinePrompt,
	}: Props = $props();
	let refinementActionLabel = $derived(
		isPromptRefinementPending ? m.prompt_refinement_cancel() : m.prompt_refinement_refine(),
	);
</script>

<div
	class="overflow-hidden rounded-md border border-input bg-background has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring"
	class:border-destructive={invalid}
	aria-busy={isPromptRefinementPending}
>
	<textarea
		bind:this={ref}
		bind:value
		{id}
		{onkeydown}
		{rows}
		{placeholder}
		readonly={readOnly}
		{disabled}
		aria-invalid={invalid}
		aria-describedby={describedBy || undefined}
		class="block w-full resize-y border-0 bg-transparent px-3 py-2 text-base leading-5 outline-none disabled:cursor-wait disabled:opacity-70 read-only:cursor-wait read-only:opacity-70 sm:pointer-fine:text-sm {textareaClass}"
	></textarea>
	<div class="flex min-h-11 items-center justify-end gap-1 px-1.5 pb-1.5 sm:pointer-fine:min-h-9">
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			class="size-11 sm:pointer-fine:size-8"
			disabled={!canExpand || isPromptRefinementPending}
			onclick={onExpand}
			aria-label={expandLabel}
			title={expandLabel}
		>
			<Maximize2 class="size-4" aria-hidden="true" />
		</Button>
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			class={isPromptRefinementPending
				? 'size-11 bg-accent text-accent-foreground hover:bg-accent/80 sm:pointer-fine:size-8'
				: 'size-11 sm:pointer-fine:size-8'}
			disabled={!isPromptRefinementPending && !canRefinePrompt}
			onclick={onRefinePrompt}
			aria-label={refinementActionLabel}
			title={refinementActionLabel}
		>
			{#if isPromptRefinementPending}
				<Square class="size-3.5" aria-hidden="true" />
			{:else}
				<Sparkles class="size-4" aria-hidden="true" />
			{/if}
		</Button>
	</div>
</div>
