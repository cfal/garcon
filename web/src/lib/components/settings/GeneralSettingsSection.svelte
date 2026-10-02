<script lang="ts">
	import { getRemoteSettings } from '$lib/context';
	import type { PinnedInsertPosition } from '$shared/settings.js';
	import * as m from '$lib/paraglide/messages.js';
	import AgentCommandsSettingsCard from './AgentCommandsSettingsCard.svelte';
	import AppTitleSettingsCard from './AppTitleSettingsCard.svelte';
	import HiddenBashCommandsSettingsCard from './HiddenBashCommandsSettingsCard.svelte';
	import TranscriptSearchSettingsCard from './TranscriptSearchSettingsCard.svelte';

	const remoteSettings = getRemoteSettings();
	let saveError = $state<string | null>(null);

	async function save(patch: Record<string, unknown>): Promise<boolean> {
		saveError = null;
		try {
			await remoteSettings.update({ ui: patch });
			return true;
		} catch (error) {
			saveError = error instanceof Error ? error.message : m.settings_save_failed();
			return false;
		}
	}

	async function onPinnedInsertPositionChange(next: PinnedInsertPosition) {
		await save({ pinnedInsertPosition: next });
	}
</script>

<div class="space-y-3">
	{#if !remoteSettings.hasSnapshot}
		<div class="py-12 flex items-center justify-center text-muted-foreground">
			{m.status_loading()}
		</div>
	{:else}
		<HiddenBashCommandsSettingsCard />

		{#if saveError}
			<div
				class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
			>
				{saveError}
			</div>
		{/if}

		<div class="bg-muted/50 border border-border rounded-lg px-4 py-2">
			<div class="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
				<div class="min-w-0">
					<label class="text-sm font-medium text-foreground" for="remote-pinned-insert-position">
						{m.sidebar_chats_pinned_insert_position()}
					</label>
					<p id="remote-pinned-insert-position-hint" class="mt-0.5 text-xs text-muted-foreground">
						{m.sidebar_chats_pinned_insert_position_activity_hint()}
					</p>
				</div>
				<select
					id="remote-pinned-insert-position"
					class="select-native shrink-0"
					aria-describedby="remote-pinned-insert-position-hint"
					value={remoteSettings.snapshot?.ui.pinnedInsertPosition ?? 'top'}
					onchange={(event) =>
						onPinnedInsertPositionChange(
							(event.currentTarget as HTMLSelectElement).value as PinnedInsertPosition,
						)}
				>
					<option value="top">{m.sidebar_chats_pinned_insert_top()}</option>
					<option value="bottom">{m.sidebar_chats_pinned_insert_bottom()}</option>
				</select>
			</div>
		</div>

		<TranscriptSearchSettingsCard />
		<AgentCommandsSettingsCard />
		<AppTitleSettingsCard />
	{/if}
</div>
