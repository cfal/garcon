<script lang="ts">
	import { getRemoteSettings } from '$lib/context';
	import { Switch } from '$lib/components/ui/switch';
	import type { AgentCommandsFeatureSettings } from '$shared/settings';
	import * as m from '$lib/paraglide/messages.js';

	const GARCON_SKILLS_URL = 'https://github.com/cfal/garcon-skills';
	const remoteSettings = getRemoteSettings();
	let pendingSetting = $state<{
		key: keyof AgentCommandsFeatureSettings;
		enabled: boolean;
	} | null>(null);
	let saveError = $state<string | null>(null);
	let commands = $derived.by(() => {
		const persisted = remoteSettings.snapshot?.features.agentCommands;
		if (!persisted || !pendingSetting) return persisted;
		return { ...persisted, [pendingSetting.key]: pendingSetting.enabled };
	});
	let isSaving = $derived(pendingSetting !== null);

	async function setCommandSetting(
		key: keyof AgentCommandsFeatureSettings,
		enabled: boolean,
	): Promise<void> {
		if (isSaving || commands?.[key] === enabled) return;
		pendingSetting = { key, enabled };
		saveError = null;
		try {
			await remoteSettings.update({
				features: { agentCommands: { [key]: enabled } },
			});
		} catch (error) {
			saveError = error instanceof Error ? error.message : m.settings_save_failed();
		} finally {
			pendingSetting = null;
		}
	}
</script>

<div class="border border-border bg-muted/50 rounded-lg px-4 py-3 space-y-3">
	<div class="flex items-center justify-between gap-4">
		<div class="min-w-0">
			<label for="agent-commands-enabled" class="text-sm font-medium text-foreground">
				{m.settings_enable_agent_commands()}
			</label>
			<div class="mt-0.5 text-xs text-muted-foreground">
				{m.settings_agent_commands_description()}{' '}
				<a
					href={GARCON_SKILLS_URL}
					target="_blank"
					rel="noreferrer noopener"
					class="underline hover:text-foreground"
				>
					{m.settings_agent_commands_docs_link()}
				</a>
			</div>
		</div>
		<Switch
			id="agent-commands-enabled"
			checked={commands?.enabled ?? true}
			disabled={isSaving}
			onCheckedChange={(checked) => void setCommandSetting('enabled', checked)}
		/>
	</div>

	{#if commands?.enabled !== false}
		<div class="space-y-2 border-t border-border pt-3">
			<div class="flex items-center justify-between gap-4">
				<label for="chat-id-discovery-enabled" class="text-sm text-foreground">
					{m.settings_enable_chat_id_discovery()}
				</label>
				<Switch
					id="chat-id-discovery-enabled"
					checked={commands?.chatIdDiscovery ?? true}
					disabled={isSaving}
					onCheckedChange={(checked) => void setCommandSetting('chatIdDiscovery', checked)}
				/>
			</div>
			<div class="flex items-center justify-between gap-4">
				<label for="send-message-enabled" class="text-sm text-foreground">
					{m.settings_enable_send_message()}
				</label>
				<Switch
					id="send-message-enabled"
					checked={commands?.sendMessage ?? true}
					disabled={isSaving}
					onCheckedChange={(checked) => void setCommandSetting('sendMessage', checked)}
				/>
			</div>
			<div class="flex items-center justify-between gap-4">
				<label for="sub-agents-enabled" class="text-sm text-foreground">
					{m.settings_enable_sub_agents()}
				</label>
				<Switch
					id="sub-agents-enabled"
					checked={commands?.subAgents ?? true}
					disabled={isSaving}
					onCheckedChange={(checked) => void setCommandSetting('subAgents', checked)}
				/>
			</div>
			{#if commands?.subAgents !== false}
				<div class="ml-4 space-y-3 border-l border-border pl-4">
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0">
							<label for="sub-agent-project-path-enabled" class="text-sm text-foreground">
								{m.settings_allow_custom_sub_agent_project_path()}
							</label>
							<div
								id="sub-agent-project-path-warning"
								class="mt-0.5 text-xs text-status-warning-muted-foreground"
							>
								{m.settings_custom_sub_agent_project_path_warning()}
							</div>
						</div>
						<Switch
							id="sub-agent-project-path-enabled"
							aria-describedby="sub-agent-project-path-warning"
							checked={commands?.allowCustomSubAgentProjectPath ?? false}
							disabled={isSaving}
							onCheckedChange={(checked) =>
								void setCommandSetting('allowCustomSubAgentProjectPath', checked)}
						/>
					</div>
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0">
							<label for="sub-agent-permission-level-enabled" class="text-sm text-foreground">
								{m.settings_allow_custom_sub_agent_permission_level()}
							</label>
							<div
								id="sub-agent-permission-level-warning"
								class="mt-0.5 text-xs text-status-warning-muted-foreground"
							>
								{m.settings_custom_sub_agent_permission_level_warning()}
							</div>
						</div>
						<Switch
							id="sub-agent-permission-level-enabled"
							aria-describedby="sub-agent-permission-level-warning"
							checked={commands?.allowCustomSubAgentPermissionLevel ?? false}
							disabled={isSaving}
							onCheckedChange={(checked) =>
								void setCommandSetting('allowCustomSubAgentPermissionLevel', checked)}
						/>
					</div>
				</div>
			{/if}
		</div>
	{/if}

	{#if saveError}
		<div class="text-xs text-destructive" role="alert">{saveError}</div>
	{/if}
</div>
