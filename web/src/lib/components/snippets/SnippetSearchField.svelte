<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import * as m from '$lib/paraglide/messages.js';

	interface Props extends Omit<HTMLInputAttributes, 'id' | 'type' | 'class' | 'value'> {
		value?: string;
	}

	let { value = $bindable(''), ...attributes }: Props = $props();
	const searchId = $props.id();
</script>

<label class="sr-only" for={searchId}>{m.snippets_search_label()}</label>
<div class="relative">
	<Search
		class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
	/>
	<input
		{...attributes}
		id={searchId}
		bind:value
		type="search"
		placeholder={m.snippets_search_placeholder()}
		class="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
	/>
</div>
