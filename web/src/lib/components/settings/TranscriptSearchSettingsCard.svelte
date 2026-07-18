<script lang="ts">
	import { getRemoteSettings } from '$lib/context';
	import { Switch } from '$lib/components/ui/switch';
	import * as m from '$lib/paraglide/messages.js';

	const remoteSettings = getRemoteSettings();
	let isSaving = $state(false);
	let saveError = $state<string | null>(null);
	let enabled = $derived(
		remoteSettings.snapshot?.features?.transcriptSearch.enabled === true,
	);

	async function setEnabled(next: boolean): Promise<void> {
		if (isSaving || next === enabled) return;
		isSaving = true;
		saveError = null;
		try {
			await remoteSettings.update({
				features: { transcriptSearch: { enabled: next } },
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
			<label for="transcript-search-enabled" class="text-sm font-medium text-foreground">
				{m.settings_transcript_search()}
			</label>
			<div class="mt-0.5 text-xs text-muted-foreground">
				{enabled
					? m.settings_transcript_search_enabled_description()
					: m.settings_transcript_search_disabled_description()}
			</div>
		</div>
		<Switch
			id="transcript-search-enabled"
			checked={enabled}
			disabled={isSaving}
			onCheckedChange={(checked) => void setEnabled(checked)}
		/>
	</div>
	{#if saveError}
		<div class="text-xs text-destructive" role="alert">{saveError}</div>
	{/if}
</div>
