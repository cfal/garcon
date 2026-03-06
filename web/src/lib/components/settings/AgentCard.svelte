<!-- Collapsible card for a single agent in settings. Shows auth status and
     login action when expanded. -->
<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Collapsible from '$lib/components/ui/collapsible/index.js';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import * as m from '$lib/paraglide/messages.js';

	interface AuthStatus {
		authenticated: boolean;
		email: string | null;
		loading: boolean;
		error: string | null;
	}

	type AgentId = 'claude' | 'codex' | 'opencode';

	let {
		agentId,
		agentName,
		auth,
		open = false,
		onOpenChange,
		onLogin
	}: {
		agentId: AgentId;
		agentName: string;
		auth: AuthStatus;
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		onLogin: () => void;
	} = $props();

	const borderColorClass: Record<AgentId, string> = {
		claude: 'border-l-provider-claude-border',
		codex: 'border-l-provider-codex-border',
		opencode: 'border-l-provider-opencode-border'
	};
</script>

<Collapsible.Root {open} {onOpenChange} class="border border-border rounded-lg overflow-hidden border-l-4 {borderColorClass[agentId]}">
	<div class="flex items-center gap-3 px-4 py-3">
		<Collapsible.Trigger class="flex flex-1 items-center gap-3 text-left cursor-pointer">
			<span class="font-medium text-foreground">{agentName}</span>

			{#if auth.loading}
				<Badge variant="secondary" class="text-xs">{m.settings_agents_auth_status_checking()}</Badge>
			{:else if auth.authenticated}
				<Badge class="text-xs bg-status-success text-status-success-foreground border-status-success-border">
					{auth.email || m.settings_agents_auth_status_connected()}
				</Badge>
			{:else}
				<Badge class="text-xs bg-status-neutral text-status-neutral-foreground border-status-neutral-border">
					{m.settings_agents_auth_status_disconnected()}
				</Badge>
			{/if}

			<ChevronDownIcon class="size-4 text-muted-foreground shrink-0 transition-transform duration-200 {open ? 'rotate-180' : ''}" />
		</Collapsible.Trigger>

		{#if !auth.loading && !auth.authenticated && !open}
			<Button variant="outline" size="sm" onclick={onLogin}>
				<LogInIcon class="size-3.5 mr-1.5" />
				{m.settings_agents_login_button()}
			</Button>
		{/if}
	</div>

	<Collapsible.Content>
		<div class="border-t border-border px-4 py-3 space-y-4">
			<div class="flex items-center justify-between">
				<div>
					<div class="text-sm font-medium text-foreground">
						{auth.authenticated ? m.settings_agents_login_re_authenticate() : m.settings_agents_login_title()}
					</div>
					<div class="text-xs text-muted-foreground">
						{auth.authenticated
							? m.settings_agents_login_re_auth_description()
							: m.settings_agents_login_description({ agent: agentName })}
					</div>
				</div>
				<Button variant={auth.authenticated ? 'outline' : 'default'} size="sm" onclick={onLogin}>
					<LogInIcon class="size-3.5 mr-1.5" />
					{auth.authenticated ? m.settings_agents_login_re_login_button() : m.settings_agents_login_button()}
				</Button>
			</div>

			{#if auth.error}
				<div class="text-sm text-destructive">
					{m.settings_agents_error({ error: auth.error })}
				</div>
			{/if}
		</div>
	</Collapsible.Content>
</Collapsible.Root>
