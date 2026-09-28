<script lang="ts">
	import { getRemoteSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import RemoteGenerationSettingsCard from './RemoteGenerationSettingsCard.svelte';

	const remoteSettings = getRemoteSettings();
</script>

<div class="space-y-3">
	{#if !remoteSettings.hasSnapshot}
		<div class="py-12 flex items-center justify-center text-muted-foreground">
			{m.status_loading()}
		</div>
	{:else}
		<RemoteGenerationSettingsCard
			settingsKey="chatTitle"
			enabledLabel={m.settings_chat_generate_titles()}
			modelLabel={m.settings_chat_title_model()}
		/>

		<RemoteGenerationSettingsCard
			settingsKey="agentSwitchCompaction"
			enabledLabel={m.settings_agent_switch_compaction_enabled()}
			modelLabel={m.settings_agent_switch_compaction_model()}
			blurb={m.settings_agent_switch_compaction_hint()}
		/>

		<RemoteGenerationSettingsCard
			settingsKey="commitMessage"
			modelLabel={m.settings_commit_message_model()}
			showDirectoryPrefix
			promptKind="commit-message"
		/>

		<RemoteGenerationSettingsCard
			settingsKey="promptRefinement"
			modelLabel={m.settings_prompt_refinement_model()}
			blurb={m.settings_prompt_refinement_hint()}
			promptKind="prompt-refinement"
		/>
	{/if}
</div>
