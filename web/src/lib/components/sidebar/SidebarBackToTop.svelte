<script lang="ts">
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	let {
		isMobile = false,
		onActivate,
	}: {
		isMobile?: boolean;
		onActivate: () => void;
	} = $props();
</script>

<div class="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
	<Button
		variant="outline"
		size="sm"
		class={[
			'pointer-events-auto rounded-full bg-card text-xs shadow-md has-[>svg]:px-3 hover:bg-accent hover:shadow-lg dark:bg-card dark:hover:bg-accent',
			isMobile && 'min-h-11 text-sm has-[>svg]:px-4',
		]}
		onclick={onActivate}
		title={m.sidebar_chats_back_to_top()}
		data-sidebar-back-to-top
	>
		<ArrowUp class="size-4" aria-hidden="true" />
		<span>{m.sidebar_chats_back_to_top()}</span>
	</Button>
</div>
