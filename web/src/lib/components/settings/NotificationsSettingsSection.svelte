<script lang="ts">
	import { getRemoteSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import TelegramSettingsPanel from './TelegramSettingsPanel.svelte';

	const remoteSettings = getRemoteSettings();
</script>

<div class="space-y-3">
	{#if !remoteSettings.hasSnapshot}
		<div class="py-12 flex items-center justify-center text-muted-foreground">
			{m.status_loading()}
		</div>
	{:else}
		<TelegramSettingsPanel />
	{/if}
</div>
