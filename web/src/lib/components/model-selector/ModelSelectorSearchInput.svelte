<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import * as m from '$lib/paraglide/messages.js';
	import type { ModelSelectorState } from './model-selector-state.svelte';

	interface Props {
		selector: ModelSelectorState;
		modelListId: string;
		activeOptionId?: string;
		ref?: HTMLInputElement | null;
		onKeydown: (event: KeyboardEvent) => void;
	}

	let {
		selector,
		modelListId,
		activeOptionId = undefined,
		ref = $bindable(null),
		onKeydown,
	}: Props = $props();

	function handleQueryInput(event: Event): void {
		selector.setQuery((event.currentTarget as HTMLInputElement).value);
	}
</script>

<div class="flex items-center gap-2 border-b border-border px-3">
	<Search class="size-4 shrink-0 text-muted-foreground" />
	<input
		bind:this={ref}
		data-slot="model-selector-search-input"
		type="text"
		value={selector.query}
		placeholder={m.model_selector_filter_placeholder()}
		aria-label={m.model_selector_filter_placeholder()}
		aria-controls={modelListId}
		aria-activedescendant={activeOptionId}
		class="flex h-10 w-full rounded-md bg-transparent py-2 text-[16px] leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
		oninput={handleQueryInput}
		onkeydown={onKeydown}
	/>
</div>
