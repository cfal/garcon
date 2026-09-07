<script lang="ts">
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import * as m from '$lib/paraglide/messages.js';

	let { announcementsEnabled = true }: { announcementsEnabled?: boolean } = $props();
</script>

<div
	class="h-full grid place-items-center px-6"
	role={announcementsEnabled ? 'status' : undefined}
	aria-live={announcementsEnabled ? 'polite' : 'off'}
>
	<div class="flex flex-col items-center gap-3 text-center text-muted-foreground">
		<Loader2 class="h-5 w-5 animate-spin" aria-hidden="true" />
		<p class="text-sm">{m.sidebar_chats_loading_chats()}</p>
	</div>
</div>
