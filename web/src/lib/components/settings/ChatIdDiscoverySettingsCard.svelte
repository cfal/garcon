<script lang="ts">
	import { getRemoteSettings } from '$lib/context';
	import { Switch } from '$lib/components/ui/switch';
	import * as m from '$lib/paraglide/messages.js';

	const GARCON_SKILLS_URL = 'https://github.com/cfal/garcon-skills';
	const remoteSettings = getRemoteSettings();
	let isSaving = $state(false);
	let saveError = $state<string | null>(null);
	let discoveryDisabled = $derived(
		remoteSettings.snapshot?.features?.chatIdDiscovery?.enabled === false,
	);

	async function setDisabled(disabled: boolean): Promise<void> {
		if (isSaving || disabled === discoveryDisabled) return;
		isSaving = true;
		saveError = null;
		try {
			await remoteSettings.update({
				features: { chatIdDiscovery: { enabled: !disabled } },
			});
		} catch (error) {
			saveError = error instanceof Error ? error.message : m.settings_save_failed();
		} finally {
			isSaving = false;
		}
	}
</script>

<div class="border border-border bg-muted/50 rounded-lg px-4 py-3 space-y-2">
	<div class="flex items-center justify-between gap-4">
		<div class="min-w-0">
			<label for="chat-id-discovery-disabled" class="text-sm font-medium text-foreground">
				{m.settings_disable_chat_id_discovery()}
			</label>
			<div class="mt-0.5 text-xs text-muted-foreground">
				{m.settings_chat_id_discovery_description()}{' '}
				<a
					href={GARCON_SKILLS_URL}
					target="_blank"
					rel="noreferrer noopener"
					class="underline hover:text-foreground"
				>
					{m.settings_chat_id_discovery_docs_link()}
				</a>
			</div>
		</div>
		<Switch
			id="chat-id-discovery-disabled"
			checked={discoveryDisabled}
			disabled={isSaving}
			onCheckedChange={(checked) => void setDisabled(checked)}
		/>
	</div>
	{#if saveError}
		<div class="text-xs text-destructive" role="alert">{saveError}</div>
	{/if}
</div>
