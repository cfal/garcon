<!-- Server-stored settings. Shows a loading state until remote settings
     are available; never renders guessed defaults. -->
<script lang="ts">
	import { getRemoteSettings } from '$lib/context';
	import type { PinnedInsertPosition } from '$lib/types/session.js';
	import * as m from '$lib/paraglide/messages.js';
	import RemoteGenerationSettingsCard from './RemoteGenerationSettingsCard.svelte';
	import TelegramSettingsPanel from './TelegramSettingsPanel.svelte';

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
		{#if saveError}
			<div
				class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
			>
				{saveError}
			</div>
		{/if}

		<div class="bg-muted/50 border border-border rounded-lg">
			<div class="flex items-center justify-between px-4 py-2">
				<div class="text-sm font-medium text-foreground">
					{m.sidebar_chats_pinned_insert_position()}
				</div>
				<select
					class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground"
					aria-label={m.sidebar_chats_pinned_insert_position()}
					value={remoteSettings.snapshot?.ui.pinnedInsertPosition ?? 'top'}
					onchange={(e) =>
						onPinnedInsertPositionChange(
							(e.currentTarget as HTMLSelectElement).value as PinnedInsertPosition,
						)}
				>
					<option value="top">{m.sidebar_chats_pinned_insert_top()}</option>
					<option value="bottom">{m.sidebar_chats_pinned_insert_bottom()}</option>
				</select>
			</div>
		</div>

		<RemoteGenerationSettingsCard
			settingsKey="chatTitle"
			enabledLabel={m.settings_chat_generate_titles()}
			modelLabel={m.settings_chat_title_model()}
		/>

		<RemoteGenerationSettingsCard
			settingsKey="commitMessage"
			enabledLabel={m.settings_commit_generate_messages()}
			modelLabel={m.settings_commit_model()}
			showDirectoryPrefix
			showPrompt
		/>

		<TelegramSettingsPanel />
	{/if}
</div>
