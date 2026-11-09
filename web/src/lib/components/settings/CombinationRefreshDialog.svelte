<script lang="ts">
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getLocalSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	let { deferred = false }: { deferred?: boolean } = $props();
	const localSettings = getLocalSettings();
	let open = $derived(
		!deferred && localSettings.combineToolUseMessages !== localSettings.activeCombineToolUseMessages,
	);
</script>

{#if open}
	<Dialog.Root bind:open>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>{m.settings_chat_combination_refresh_title()}</Dialog.Title>
				<Dialog.Description>{m.settings_chat_combination_refresh_description()}</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}
					>{m.settings_chat_combination_refresh_later()}</Button
				>
				<Button onclick={() => window.location.reload()}>
					<RefreshCw class="size-4" />
					{m.common_refresh()}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
