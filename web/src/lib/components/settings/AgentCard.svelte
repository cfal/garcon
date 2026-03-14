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
		canReauth: boolean;
		label: string;
		loading: boolean;
		error: string | null;
	}

	type AgentId = 'claude' | 'codex' | 'opencode' | 'amp';

	let {
		agentId,
		agentName,
		auth,
		open = false,
		onOpenChange,
		onLogin,
		cliOnly = false
	}: {
		agentId: AgentId;
		agentName: string;
		auth: AuthStatus;
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		onLogin: () => void;
		cliOnly?: boolean;
	} = $props();

	const borderColorClass: Record<AgentId, string> = {
		claude: 'border-l-provider-claude-border',
		codex: 'border-l-provider-codex-border',
		opencode: 'border-l-provider-opencode-border',
		amp: 'border-l-provider-amp-border'
	};

	// Authenticated with no reauth option and no CLI-only content -- nothing to expand.
	let expandable = $derived(!auth.loading && !(auth.authenticated && !auth.canReauth && !cliOnly));
</script>

{#if expandable}
<Collapsible.Root {open} {onOpenChange} class="border border-border rounded-lg overflow-hidden border-l-4 {borderColorClass[agentId]}">
	<div class="flex items-center gap-3 px-4 py-3">
		<Collapsible.Trigger class="flex flex-1 items-center gap-3 text-left cursor-pointer">
			<span class="font-medium text-foreground">{agentName}</span>

			{#if auth.loading}
				<Badge variant="secondary" class="text-xs">{m.settings_agents_auth_status_checking()}</Badge>
			{:else if auth.authenticated}
				<Badge class="text-xs bg-status-success text-status-success-foreground border-status-success-border">
					{auth.label || m.settings_agents_auth_status_connected()}
				</Badge>
			{:else}
				<Badge class="text-xs bg-status-neutral text-status-neutral-foreground border-status-neutral-border">
					{m.settings_agents_auth_status_disconnected()}
				</Badge>
			{/if}

			<ChevronDownIcon class="size-4 text-muted-foreground shrink-0 transition-transform duration-200 {open ? 'rotate-180' : ''}" />
		</Collapsible.Trigger>

		{#if !auth.loading && !auth.authenticated && !open && auth.canReauth}
			<Button variant="outline" size="sm" onclick={onLogin}>
				<LogInIcon class="size-3.5 mr-1.5" />
				{m.settings_agents_login_button()}
			</Button>
		{/if}
	</div>

	<Collapsible.Content>
		<div class="border-t border-border px-4 py-3 space-y-4">
			{#if cliOnly}
				<div class="text-xs text-muted-foreground">
					{#if auth.authenticated}
						Authenticated via CLI. To switch accounts, run <code class="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{agentName.toLowerCase()} login</code> in your terminal.
					{:else}
						Run <code class="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{agentName.toLowerCase()} login</code> in your terminal to authenticate.
					{/if}
				</div>
			{:else if auth.canReauth}
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
			{/if}

			{#if auth.error}
				<div class="text-sm text-destructive">
					{m.settings_agents_error({ error: auth.error })}
				</div>
			{/if}
		</div>
	</Collapsible.Content>
</Collapsible.Root>
{:else}
<div class="border border-border rounded-lg overflow-hidden border-l-4 {borderColorClass[agentId]}">
	<div class="flex items-center gap-3 px-4 py-3">
		<span class="font-medium text-foreground">{agentName}</span>

		{#if auth.loading}
			<Badge variant="secondary" class="text-xs">{m.settings_agents_auth_status_checking()}</Badge>
		{:else if auth.authenticated}
			<Badge class="text-xs bg-status-success text-status-success-foreground border-status-success-border">
				{auth.label || m.settings_agents_auth_status_connected()}
			</Badge>
		{/if}
	</div>
</div>
{/if}
