<script lang="ts">
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { getGhCapability } from '$lib/context';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	const ghCapability = getGhCapability();

	const connectedAccount = $derived(
		ghCapability.login && ghCapability.host ? `${ghCapability.login}@${ghCapability.host}` : null,
	);

	const statusLabel = $derived.by(() => {
		if (!ghCapability.hasChecked || ghCapability.isLoading) return m.settings_gh_status_checking();
		if (ghCapability.lastError) return m.settings_gh_status_error();
		if (ghCapability.available) {
			return connectedAccount
				? m.settings_gh_status_connected_as({ account: connectedAccount })
				: m.settings_gh_status_connected();
		}
		if (ghCapability.reason === 'gh_missing') return m.settings_gh_status_missing();
		if (ghCapability.reason === 'auth_error') return m.settings_gh_status_auth_error();
		if (ghCapability.reason === 'unknown') return m.settings_gh_status_error();
		return m.settings_gh_status_disconnected();
	});

	const badgeClass = $derived.by(() => {
		if (!ghCapability.hasChecked || ghCapability.isLoading) {
			return 'bg-status-neutral text-status-neutral-foreground border-status-neutral-border';
		}
		if (ghCapability.available) {
			return 'bg-status-success text-status-success-foreground border-status-success-border';
		}
		if (ghCapability.reason === 'gh_missing' || ghCapability.reason === 'unauthenticated') {
			return 'bg-status-neutral text-status-neutral-foreground border-status-neutral-border';
		}
		return 'bg-status-warning/20 text-status-warning-muted-foreground border-status-warning-border';
	});

	async function refreshGhStatus(): Promise<void> {
		await ghCapability.refresh();
	}
</script>

<section class="rounded-lg border border-border bg-muted/50">
	<div class="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
		<div class="flex min-w-0 items-start gap-3">
			<div
				class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground"
			>
				<GitPullRequest class="size-4" />
			</div>
			<div class="min-w-0 space-y-1">
				<div class="text-sm font-medium text-foreground">{m.settings_gh_title()}</div>
				<div class="text-xs text-muted-foreground">{m.settings_gh_description()}</div>
			</div>
		</div>

		<div class="flex shrink-0 items-center gap-2">
			<Badge variant="outline" class={cn('text-xs', badgeClass)}>{statusLabel}</Badge>
			<Button
				variant="outline"
				size="sm"
				onclick={refreshGhStatus}
				disabled={ghCapability.isLoading}
				aria-label={m.settings_gh_refresh_aria()}
			>
				<RefreshCw class={cn('size-3.5', ghCapability.isLoading && 'animate-spin')} />
				{m.settings_gh_refresh()}
			</Button>
		</div>
	</div>

	<div class="space-y-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
		{#if !ghCapability.hasChecked || ghCapability.isLoading}
			<p>{m.settings_gh_instructions_checking()}</p>
		{:else if ghCapability.lastError}
			<p class="text-destructive">{m.settings_gh_instructions_error({ error: ghCapability.lastError })}</p>
		{:else if ghCapability.available}
			<p>{m.settings_gh_instructions_connected()}</p>
		{:else if ghCapability.reason === 'gh_missing'}
			<p>{m.settings_gh_instructions_missing()}</p>
		{:else if ghCapability.reason === 'auth_error'}
			<p>{m.settings_gh_instructions_auth_error()}</p>
		{:else if ghCapability.reason === 'unknown'}
			<p>{m.settings_gh_instructions_unknown()}</p>
		{:else}
			<p>{m.settings_gh_instructions_unauthenticated()}</p>
			<code
				class="inline-flex rounded bg-background px-2 py-1 font-mono text-[11px] text-foreground"
			>
				{m.settings_gh_command_auth_login()}
			</code>
			<p>{m.settings_gh_instructions_token()}</p>
			<p>{m.settings_gh_instructions_refresh()}</p>
		{/if}
	</div>
</section>
