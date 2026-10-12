<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import SharedChatPage from '$lib/components/chat/SharedChatPage.svelte';

	const token = $derived(page.params.token || '');
	const canonicalPath = $derived(token ? resolve('/shared/[token]', { token }) : null);
</script>

<SharedChatPage {token} {canonicalPath} />
