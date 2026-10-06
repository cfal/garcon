<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import ApiProviderEndpointDialog from './ApiProviderEndpointDialog.svelte';
	import { detectApiKeyProvider, type ApiKeyProviderDraft } from './api-key-provider';

	let apiKey = $state('');
	let draft = $state<ApiKeyProviderDraft | null>(null);
	const detected = $derived(detectApiKeyProvider(apiKey));

	function review(): void {
		if (!detected) return;
		draft = { template: detected, apiKey: apiKey.trim() };
		apiKey = '';
	}
</script>

<form
	class="space-y-3 rounded-lg border border-border bg-card p-4"
	onsubmit={(event) => {
		event.preventDefault();
		review();
	}}
>
	<label for="provider-quick-key" class="block text-sm font-medium"
		>{m.settings_key_setup_title()}</label
	>
	<p id="provider-quick-key-help" class="text-sm text-muted-foreground">
		{m.settings_key_setup_description()}
	</p>
	<div class="flex flex-col gap-2 sm:flex-row">
		<Input
			id="provider-quick-key"
			type="password"
			bind:value={apiKey}
			autocomplete="off"
			spellcheck={false}
			aria-describedby="provider-quick-key-help"
			placeholder={m.settings_key_setup_placeholder()}
		/>
		<Button type="submit" variant="outline" disabled={!detected}
			>{m.settings_key_setup_review()}</Button
		>
	</div>
	{#if apiKey.trim()}
		<p role="status" class="text-sm text-muted-foreground">
			{detected
				? m.settings_key_setup_detected({ provider: detected.label })
				: m.settings_key_setup_unknown()}
		</p>
	{/if}
</form>

{#if draft}
	<ApiProviderEndpointDialog
		open
		protocol={draft.template.protocol}
		initialKeyDraft={draft}
		onOpenChange={(open) => {
			if (!open) draft = null;
		}}
	/>
{/if}
