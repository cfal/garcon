<script lang="ts">
	import { page } from '$app/state';
	import SharedChatPage from '$lib/components/chat/SharedChatPage.svelte';

	const token = $derived(page.params.token || '');
	const canonicalPath = $derived(token ? `/shared/${token}` : null);
</script>

<SharedChatPage {token} {canonicalPath} />
