<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import ApiProviderProtocolPanel from './ApiProviderProtocolPanel.svelte';
	import ExecutorAgentSettings from './ExecutorAgentSettings.svelte';
	import SettingsExecutorSections from './SettingsExecutorSections.svelte';
</script>

<div class="space-y-8">
	<section class="space-y-4">
		<h2 class="text-base font-semibold">{m.settings_native_providers()}</h2>
		<SettingsExecutorSections>
			{#snippet children(executorId)}<ExecutorAgentSettings {executorId} section="native" />{/snippet}
		</SettingsExecutorSections>
	</section>
	<section class="space-y-6 border-t border-border pt-6">
		<h2 class="text-base font-semibold">{m.settings_custom_providers()}</h2>
		<ApiProviderProtocolPanel
			protocol="openai-compatible"
			title={m.settings_api_providers_openai_title()}
			description={m.settings_api_providers_openai_description()}
			addLabel={m.settings_api_providers_add_openai_provider()}
		/>

		<ApiProviderProtocolPanel
			protocol="anthropic-messages"
			title={m.settings_api_providers_anthropic_title()}
			description={m.settings_api_providers_anthropic_description()}
			addLabel={m.settings_api_providers_add_anthropic_provider()}
		/>
	</section>
</div>
