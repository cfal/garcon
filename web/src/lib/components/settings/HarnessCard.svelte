<!-- Renders one harness auth/readiness card. -->
<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Collapsible from '$lib/components/ui/collapsible/index.js';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import * as m from '$lib/paraglide/messages.js';
	import type { DeviceAuthInfo, HarnessReadiness } from '$lib/api/providers.js';

	interface AuthStatus {
		authenticated: boolean;
		canReauth: boolean;
		label: string;
		loading: boolean;
		error: string | null;
	}

	type HarnessId = string;

	let {
		harnessId,
		harnessName,
		auth,
		open = false,
		onOpenChange,
		onLogin = () => undefined,
		cliOnly = false,
		loginCommand = `${harnessName.toLowerCase()} login`,
		deviceAuth = undefined,
		pending = false,
		readiness = undefined,
		noLogin = false
	}: {
		harnessId: HarnessId;
		harnessName: string;
		auth: AuthStatus;
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		onLogin?: () => void;
		cliOnly?: boolean;
		loginCommand?: string;
		deviceAuth?: DeviceAuthInfo;
		pending?: boolean;
		readiness?: HarnessReadiness;
		noLogin?: boolean;
	} = $props();

	let codeCopied = $state(false);

	async function copyDeviceCode() {
		if (!deviceAuth) return;
		await navigator.clipboard.writeText(deviceAuth.code);
		codeCopied = true;
		setTimeout(() => { codeCopied = false; }, 2000);
	}

	const borderColorClass: Record<HarnessId, string> = {
		claude: 'border-l-provider-claude-border',
		codex: 'border-l-provider-codex-border',
		opencode: 'border-l-provider-opencode-border',
		amp: 'border-l-provider-amp-border',
		factory: 'border-l-provider-factory-border',
		pi: 'border-l-provider-pi-border',
		'direct-openai-compatible': 'border-l-border',
		'direct-openai-responses-compatible': 'border-l-border',
		'direct-anthropic-compatible': 'border-l-border'
	};

	let isReady = $derived(auth.authenticated || readiness?.ready === true);
	let statusLabel = $derived(auth.authenticated
		? (auth.label || m.settings_agents_auth_status_connected())
		: readiness?.ready === true
			? 'Ready'
			: m.settings_agents_auth_status_disconnected()
	);
	let expandable = $derived(!auth.loading && !noLogin && !(auth.authenticated && !auth.canReauth && !cliOnly));
</script>

{#if expandable}
<Collapsible.Root {open} {onOpenChange} class="border border-border rounded-lg overflow-hidden border-l-4 {borderColorClass[harnessId]}">
	<div class="flex items-center gap-3 px-4 py-3">
		<Collapsible.Trigger class="flex flex-1 items-center gap-3 text-left cursor-pointer">
			<span class="font-medium text-foreground">{harnessName}</span>

			{#if auth.loading}
				<Badge variant="secondary" class="text-xs">{m.settings_agents_auth_status_checking()}</Badge>
			{:else if isReady}
				<Badge class="text-xs bg-status-success text-status-success-foreground border-status-success-border">
					{statusLabel}
				</Badge>
			{:else}
				<Badge class="text-xs bg-status-neutral text-status-neutral-foreground border-status-neutral-border">
					{m.settings_agents_auth_status_disconnected()}
				</Badge>
			{/if}

			<ChevronDownIcon class="size-4 text-muted-foreground shrink-0 transition-transform duration-200 {open ? 'rotate-180' : ''}" />
		</Collapsible.Trigger>

		{#if !cliOnly && !noLogin && !auth.loading && !auth.authenticated && !open && auth.canReauth && !deviceAuth}
			<Button variant="outline" size="sm" onclick={onLogin} disabled={pending}>
				{#if pending}
					<LoaderIcon class="size-3.5 mr-1.5 animate-spin" />
				{:else}
					<LogInIcon class="size-3.5 mr-1.5" />
				{/if}
				{m.settings_agents_login_button()}
			</Button>
		{/if}
	</div>

	<Collapsible.Content>
		<div class="border-t border-border px-4 py-3 space-y-4">
			{#if deviceAuth}
				<div class="space-y-3">
					<div class="text-sm font-medium text-foreground">{m.settings_agents_device_auth_title()}</div>

					<div class="space-y-1">
						<div class="text-xs text-muted-foreground">{m.settings_agents_device_auth_step1()}</div>
						<div class="flex items-center gap-2">
							<a
								href={deviceAuth.url}
								target="_blank"
								rel="noopener noreferrer"
								class="text-sm text-primary underline underline-offset-2 hover:text-primary/80"
							>
								{deviceAuth.url}
							</a>
							<Button variant="ghost" size="icon-sm" onclick={() => window.open(deviceAuth.url, '_blank', 'noopener')}>
								<ExternalLinkIcon class="size-3.5" />
							</Button>
						</div>
					</div>

					<div class="space-y-1">
						<div class="text-xs text-muted-foreground">{m.settings_agents_device_auth_step2()}</div>
						<div class="flex items-center gap-2">
							<code class="rounded bg-muted px-2.5 py-1 font-mono text-base font-semibold text-foreground tracking-wider">
								{deviceAuth.code}
							</code>
							<Button variant="ghost" size="icon-sm" onclick={copyDeviceCode}>
								{#if codeCopied}
									<CheckIcon class="size-3.5 text-status-success" />
								{:else}
									<CopyIcon class="size-3.5" />
								{/if}
							</Button>
						</div>
					</div>

					<div class="flex items-center gap-2 text-xs text-muted-foreground">
						<LoaderIcon class="size-3.5 animate-spin" />
						{m.settings_agents_device_auth_waiting()}
					</div>
				</div>
			{:else if cliOnly}
				<div class="text-xs text-muted-foreground">
					{#if auth.authenticated}
						Authenticated via CLI. To switch accounts, run <code class="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{loginCommand}</code> in your terminal.
					{:else}
						Run <code class="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{loginCommand}</code> in your terminal to authenticate.
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
								: m.settings_agents_login_description({ agent: harnessName })}
						</div>
					</div>
					<Button variant={auth.authenticated ? 'outline' : 'default'} size="sm" onclick={onLogin} disabled={pending}>
						{#if pending}
							<LoaderIcon class="size-3.5 mr-1.5 animate-spin" />
						{:else}
							<LogInIcon class="size-3.5 mr-1.5" />
						{/if}
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
<div class="border border-border rounded-lg overflow-hidden border-l-4 {borderColorClass[harnessId]}">
	<div class="flex items-center gap-3 px-4 py-3">
		<span class="font-medium text-foreground">{harnessName}</span>

		{#if auth.loading}
			<Badge variant="secondary" class="text-xs">{m.settings_agents_auth_status_checking()}</Badge>
		{:else if isReady}
			<Badge class="text-xs bg-status-success text-status-success-foreground border-status-success-border">
				{statusLabel}
			</Badge>
		{/if}
	</div>
</div>
{/if}
