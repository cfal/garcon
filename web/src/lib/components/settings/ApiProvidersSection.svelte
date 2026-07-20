<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { nativeSourceLabelFor } from '$lib/agents/agent-labels';
	import ApiProviderProtocolPanel from './ApiProviderProtocolPanel.svelte';
	import type { SettingsAuthState } from './settings-auth-state.svelte.js';

	let { settingsAuth }: { settingsAuth: SettingsAuthState } = $props();

	function completeCodexLogin(code: string): void {
		void settingsAuth.completeLogin('codex', code);
	}

	function completeClaudeLogin(code: string): void {
		void settingsAuth.completeLogin('claude', code);
	}
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
		onLogin={() => settingsAuth.handleLogin('codex')}
		onCompleteLogin={completeCodexLogin}
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
		onLogin={() => settingsAuth.handleLogin('claude')}
		onCompleteLogin={completeClaudeLogin}
	/>
</section>
