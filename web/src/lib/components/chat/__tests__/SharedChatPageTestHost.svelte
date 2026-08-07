<script lang="ts">
	import SharedChatPage from '../SharedChatPage.svelte';
	import { setAppTitle } from '$lib/context';
	import { createAppTitleStore } from '$lib/stores/app-title.svelte';

	let { token = 'share-token' }: { token?: string } = $props();
	setAppTitle(createAppTitleStore());
</script>

<SharedChatPage {token} />
