<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import type { PullRequestReviewsStore } from '$lib/git/pull-requests/pull-request-reviews-store.svelte.js';
	import { getExecutors } from '$lib/context';
	import { agentLabelFor } from '$lib/agents/agent-labels';
	import { cn } from '$lib/utils/cn';
	import { effectiveExecutorId } from '$shared/executors';
	import type { PullRequestReviewRepository } from '$shared/pull-request-reviews';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp';
	import { errorMessage } from '$lib/utils/error-message.js';
	import * as m from '$lib/paraglide/messages.js';
	import PullRequestRecentRunRow from './PullRequestRecentRunRow.svelte';
	import PullRequestRepositoryDialog from './PullRequestRepositoryDialog.svelte';
	import PullRequestRecoveryRuns from './PullRequestRecoveryRuns.svelte';

	interface Props {
		reviews: PullRequestReviewsStore;
		onOpenChat: (chatId: string) => void;
	}

	let { reviews, onOpenChat }: Props = $props();
	let currentTime = $state(new Date());
	onMount(() => {
		void reviews.ensureLoaded();
		const timer = setInterval(() => (currentTime = new Date()), 60_000);
		return () => clearInterval(timer);
	});
	const executors = getExecutors();

	// The repository being edited; null connects a new one.
	let editing = $state<{ repository: PullRequestReviewRepository | null } | null>(null);
	let removing = $state<string | null>(null);
	let error = $state<string | null>(null);
	let showingRecovery = $state(false);

	function executorLabel(repository: PullRequestReviewRepository): string {
		const id = effectiveExecutorId(repository.target.executorId);
		return executors.get(id)?.label ?? id;
	}

	function scanLabel(repository: PullRequestReviewRepository): string {
		const { scan } = repository;
		if (scan.status === 'executor-unavailable') return m.pull_request_repository_scan_offline();
		if (scan.status === 'failed') return scan.message ?? m.pull_request_repository_scan_failed();
		return (
			formatRelativeTimestamp(scan.scannedAt, currentTime)?.label ??
			m.pull_request_repository_scan_pending()
		);
	}

	async function run(action: () => Promise<void>): Promise<void> {
		error = null;
		try {
			await action();
		} catch (failure) {
			error = errorMessage(failure, m.pull_request_review_action_failed());
		}
	}

	function setAutoReview(
		repository: PullRequestReviewRepository,
		autoReview: boolean,
	): Promise<void> {
		return run(() =>
			reviews.update(repository.id, {
				target: repository.target,
				settings: { ...repository.settings, autoReview },
			}),
		);
	}

	function repositoryName(repositoryId: string): string {
		return reviews.repositoryLabel(repositoryId);
	}
</script>

<div class="min-w-0 space-y-4" data-pr-repositories-panel>
	<div class="flex items-center justify-end">
		<Button size="sm" onclick={() => (editing = { repository: null })} data-pr-connect-repository>
			<Plus class="mr-1.5 h-4 w-4" />
			{m.pull_request_repository_connect()}
		</Button>
	</div>
	{#if error}
		<p class="text-sm text-status-error-foreground" role="alert">{error}</p>
	{/if}
	{#if reviews.error}
		<div class="space-y-2" role="alert">
			<p class="break-words text-sm text-status-error-foreground">{reviews.error}</p>
			<Button
				size="sm"
				variant="outline"
				disabled={reviews.status === 'loading' || reviews.isRefreshing}
				onclick={() => reviews.refresh()}>{m.common_retry()}</Button
			>
		</div>
	{/if}
	{#if !reviews.snapshot}
		{#if reviews.status !== 'error'}<p class="text-sm text-muted-foreground" role="status">
				{m.common_loading()}
			</p>{/if}
	{:else if reviews.repositories.length === 0}
		<p class="rounded-md border border-border px-3 py-8 text-center text-sm text-muted-foreground">
			{m.pull_request_inbox_no_repositories()}
		</p>
	{:else}
		<div class="repositories rounded-md border border-border">
			<table class="w-full text-left text-sm" data-pr-repositories-table>
				<thead class="border-b border-border bg-muted/50 text-xs text-muted-foreground">
					<tr>
						<th class="px-3 py-2 font-medium">{m.pull_request_repository_column_repository()}</th>
						<th class="px-3 py-2 font-medium">{m.pull_request_repository_column_executor()}</th>
						<th class="px-3 py-2 font-medium">{m.pull_request_repository_column_auto_review()}</th>
						<th class="px-3 py-2 font-medium">{m.pull_request_repository_column_reviewer()}</th>
						<th class="px-3 py-2 font-medium">{m.pull_request_repository_column_posting()}</th>
						<th class="px-3 py-2 font-medium">{m.pull_request_repository_column_last_scan()}</th>
						<th class="px-3 py-2"><span class="sr-only">{m.workspace_surface_actions()}</span></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each reviews.repositories as repository (repository.id)}
						<tr data-pr-repository={repository.nameWithOwner}>
							<td
								data-label={m.pull_request_repository_column_repository()}
								class="max-w-56 px-3 py-2"
							>
								<p class="break-words font-medium text-foreground">
									{repositoryName(repository.id)}
								</p>
								<p
									class="truncate font-mono text-xs text-muted-foreground"
									title={repository.target.projectPath}
								>
									{repository.target.projectPath}
								</p>
							</td>
							<td
								data-label={m.pull_request_repository_column_executor()}
								class="px-3 py-2 text-xs text-muted-foreground"
							>
								<p>{executorLabel(repository)}</p>
								{#if repository.viewerLogin}<p>@{repository.viewerLogin}</p>{/if}
							</td>
							<td data-label={m.pull_request_repository_column_auto_review()} class="px-3 py-2">
								<Switch
									checked={repository.settings.autoReview}
									onCheckedChange={(next) => setAutoReview(repository, Boolean(next))}
									aria-label={m.pull_request_repository_auto_review_for({
										repository: repositoryName(repository.id),
									})}
								/>
							</td>
							<td
								data-label={m.pull_request_repository_column_reviewer()}
								class="px-3 py-2 text-xs text-muted-foreground"
							>
								<p class="truncate">{agentLabelFor(repository.target.agentId)}</p>
								<p class="truncate">{repository.target.model}</p>
							</td>
							<td
								data-label={m.pull_request_repository_column_posting()}
								class="px-3 py-2 text-xs text-muted-foreground"
								>{repository.settings.autoPost
									? m.pull_request_repository_posting_automatic()
									: m.pull_request_repository_posting_manual()}</td
							>
							<td
								data-label={m.pull_request_repository_column_last_scan()}
								class="max-w-40 px-3 py-2 text-xs text-muted-foreground"
							>
								<p class="line-clamp-2" title={repository.scan.message ?? undefined}>
									{scanLabel(repository)}
								</p>
							</td>
							<td data-actions class="px-2 py-2">
								<div class="flex items-center justify-end gap-0.5">
									{#if removing === repository.id}
										<Button
											size="sm"
											variant="destructive"
											onclick={() =>
												run(async () => {
													await reviews.remove(repository.id);
													removing = null;
												})}>{m.pull_request_repository_disconnect()}</Button
										>
										<Button size="sm" variant="ghost" onclick={() => (removing = null)}
											>{m.common_cancel()}</Button
										>
									{:else}
										<Button
											size="icon-sm"
											variant="ghost"
											aria-label={m.pull_request_repository_scan_now()}
											title={m.pull_request_repository_scan_now()}
											disabled={reviews.isScanningRepository(repository.id)}
											onclick={() => run(() => reviews.scan(repository.id))}
										>
											<RefreshCw
												class={cn(
													'h-4 w-4',
													reviews.isScanningRepository(repository.id) && 'animate-spin',
												)}
											/>
										</Button>
										<Button
											size="icon-sm"
											variant="ghost"
											aria-label={m.pull_request_repository_edit({
												repository: repositoryName(repository.id),
											})}
											onclick={() => (editing = { repository })}
										>
											<Pencil class="h-4 w-4" />
										</Button>
										<Button
											size="icon-sm"
											variant="ghost"
											aria-label={m.pull_request_repository_disconnect_named({
												repository: repositoryName(repository.id),
											})}
											onclick={() => (removing = repository.id)}
										>
											<Trash2 class="h-4 w-4" />
										</Button>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	{#if reviews.snapshot}
		<section>
			<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
				<h3 class="text-sm font-medium text-foreground">
					{showingRecovery
						? m.pull_request_review_recovery_title()
						: m.pull_request_repository_recent_runs()}
				</h3>
				<Button size="sm" variant="ghost" onclick={() => (showingRecovery = !showingRecovery)}
					>{showingRecovery
						? m.pull_request_repository_recent_runs()
						: m.pull_request_review_show_recovery()}</Button
				>
			</div>
			{#if showingRecovery}
				<PullRequestRecoveryRuns
					{currentTime}
					{repositoryName}
					{onOpenChat}
					onPost={(runId) => reviews.post(runId)}
					onAbandon={(runId) => reviews.abandon(runId)}
				/>
			{:else if reviews.recentRuns.length === 0}
				<p class="text-sm text-muted-foreground">
					{m.pull_request_repository_recent_runs_empty()}
				</p>
			{:else}
				<ol class="divide-y divide-border rounded-md border border-border" data-pr-run-log>
					{#each reviews.recentRuns as entry (entry.id)}
						<PullRequestRecentRunRow
							run={entry}
							repositoryName={repositoryName(entry.repositoryId)}
							{currentTime}
							{onOpenChat}
							onPost={(runId) => reviews.post(runId)}
							onAbandon={(runId) => reviews.abandon(runId)}
						/>
					{/each}
				</ol>
			{/if}
		</section>
	{/if}
</div>

{#if editing}
	<PullRequestRepositoryDialog
		repository={editing.repository}
		onSave={(input) =>
			editing?.repository ? reviews.update(editing.repository.id, input) : reviews.connect(input)}
		onClose={() => (editing = null)}
	/>
{/if}

<style>
	.repositories {
		container-type: inline-size;
	}
	@container (max-width: 42rem) {
		table,
		tbody {
			display: block;
		}
		thead {
			display: none;
		}
		tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			padding: 0.5rem;
		}
		td {
			display: block;
			min-width: 0;
			max-width: none;
			padding: 0.5rem;
			overflow-wrap: anywhere;
		}
		td::before {
			content: attr(data-label);
			display: block;
			margin-bottom: 0.25rem;
			font-size: 0.75rem;
			color: var(--muted-foreground);
		}
		td:first-child,
		td[data-actions] {
			grid-column: 1 / -1;
		}
		td[data-actions]::before {
			display: none;
		}
	}
</style>
