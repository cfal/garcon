<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';

	const loadRenderer = () => import('$lib/components/chat/SharedChatPage.svelte');
	let renderer = $state.raw(loadRenderer());

	const token = $derived(page.params.token || '');
	const canonicalPath = $derived(token ? resolve('/shared/[token]', { token }) : null);
</script>

{#await renderer}
	<p class="p-4" role="status">{m.shared_view_loading()}</p>
{:then { default: SharedChatPage }}
	{#key token}<SharedChatPage {token} {canonicalPath} />{/key}
{:catch}
	<div class="p-4">
		<p role="alert">{m.shared_view_load_failed()}</p>
		<button type="button" class="underline" onclick={() => (renderer = loadRenderer())}>{m.common_retry()}</button>
	</div>
{/await}
