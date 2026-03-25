<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import * as m from '$lib/paraglide/messages.js';

	const is404 = $derived(page.status === 404);
</script>

<div class="h-full grid place-items-center bg-background px-6">
	<div class="max-w-md text-center space-y-4">
		<div class="flex justify-center">
			<TriangleAlert class="h-10 w-10 text-muted-foreground" />
		</div>
		<p class="text-4xl font-bold text-foreground">{page.status}</p>
		<h1 class="text-xl font-semibold text-foreground">
			{is404 ? m.error_page_not_found() : m.error_unexpected()}
		</h1>
		<p class="text-sm text-muted-foreground">
			{is404 ? m.error_page_not_found_description() : m.error_unexpected_description()}
		</p>
		<div class="pt-2">
			<Button href="/">{m.error_go_home()}</Button>
		</div>
	</div>
</div>
