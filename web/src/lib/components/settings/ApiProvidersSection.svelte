<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { nativeSourceLabelFor } from '$lib/i18n/agent-labels';
	import ApiProviderProtocolPanel from './ApiProviderProtocolPanel.svelte';
	import type { SettingsAuthState } from './settings-auth-state.svelte.js';

	let { settingsAuth }: { settingsAuth: SettingsAuthState } = $props();
</script>

<section class="space-y-8">
	<ApiProviderProtocolPanel
		protocol="openai-compatible"
		title={m.settings_api_providers_openai_title()}
		description={m.settings_api_providers_openai_description()}
		addLabel={m.settings_api_providers_add_openai_provider()}
		oauthAgent={{ id: 'codex', name: nativeSourceLabelFor('codex') }}
		auth={settingsAuth.authFor('codex')}
		readiness={settingsAuth.readinessFor('codex')}
		deviceAuth={settingsAuth.deviceAuthFor('codex')}
		pending={settingsAuth.isLoginPending('codex')}
		onLogin={() => void settingsAuth.handleLogin('codex')}
	/>

	<ApiProviderProtocolPanel
		protocol="anthropic-messages"
		title={m.settings_api_providers_anthropic_title()}
		description={m.settings_api_providers_anthropic_description()}
		addLabel={m.settings_api_providers_add_anthropic_provider()}
		oauthAgent={{ id: 'claude', name: nativeSourceLabelFor('claude') }}
		auth={settingsAuth.authFor('claude')}
		readiness={settingsAuth.readinessFor('claude')}
		deviceAuth={settingsAuth.deviceAuthFor('claude')}
		pending={settingsAuth.isLoginPending('claude')}
		onLogin={() => void settingsAuth.handleLogin('claude')}
	/>
</section>
