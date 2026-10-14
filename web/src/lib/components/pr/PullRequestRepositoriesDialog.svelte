<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import * as Dialog from '$lib/components/ui/dialog';
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
	import PullRequestReviewChip from './PullRequestReviewChip.svelte';
	import PullRequestRepositoryDialog from './PullRequestRepositoryDialog.svelte';
	import { reviewRunChip } from './pr-display';

	interface Props {
		reviews: PullRequestReviewsStore;
		currentTime: Date;
		onOpenChat: (chatId: string) => void;
		onClose: () => void;
	}

	let { reviews, currentTime, onOpenChat, onClose }: Props = $props();
	const executors = getExecutors();

	// The repository being edited; null connects a new one.
	let editing = $state<{ repository: PullRequestReviewRepository | null } | null>(null);
	let removing = $state<string | null>(null);
	let error = $state<string | null>(null);

	const postingLabels = {
		off: m.pull_request_repository_posting_off,
		draft: m.pull_request_repository_posting_draft,
		comment: m.pull_request_repository_posting_comment,
	} as const;

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
		return reviews.repository(repositoryId)?.nameWithOwner ?? '';
	}
</script>

<Dialog.Root open onOpenChange={(value) => !value && onClose()}>
	<Dialog.Content class="flex max-h-[85dvh] flex-col sm:max-w-4xl" data-pr-repositories-dialog>
		<Dialog.Header>
			<Dialog.Title>{m.pull_request_repositories()}</Dialog.Title>
			<Dialog.Description>{m.pull_request_repositories_description()}</Dialog.Description>
		</Dialog.Header>
		<div class="min-h-0 flex-1 space-y-4 overflow-y-auto">
			<div class="flex items-center justify-end">
				<Button
					size="sm"
					onclick={() => (editing = { repository: null })}
					data-pr-connect-repository
				>
					<Plus class="mr-1.5 h-4 w-4" />
					{m.pull_request_repository_connect()}
				</Button>
			</div>
			{#if error}
				<p class="text-sm text-status-error-foreground" role="alert">{error}</p>
			{/if}
			{#if reviews.repositories.length === 0}
				<p
					class="rounded-md border border-border px-3 py-8 text-center text-sm text-muted-foreground"
				>
					{m.pull_request_inbox_no_repositories()}
				</p>
			{:else}
				<div class="overflow-x-auto rounded-md border border-border">
					<table class="w-full text-left text-sm" data-pr-repositories-table>
						<thead class="border-b border-border bg-muted/50 text-xs text-muted-foreground">
							<tr>
								<th class="px-3 py-2 font-medium"
									>{m.pull_request_repository_column_repository()}</th
								>
								<th class="px-3 py-2 font-medium">{m.pull_request_repository_column_executor()}</th>
								<th class="px-3 py-2 font-medium"
									>{m.pull_request_repository_column_auto_review()}</th
								>
								<th class="px-3 py-2 font-medium">{m.pull_request_repository_column_reviewer()}</th>
								<th class="px-3 py-2 font-medium">{m.pull_request_repository_column_posting()}</th>
								<th class="px-3 py-2 font-medium">{m.pull_request_repository_column_last_scan()}</th
								>
								<th class="px-3 py-2"
									><span class="sr-only">{m.workspace_surface_actions()}</span></th
								>
							</tr>
						</thead>
						<tbody class="divide-y divide-border">
							{#each reviews.repositories as repository (repository.id)}
								<tr data-pr-repository={repository.nameWithOwner}>
									<td class="max-w-56 px-3 py-2">
										<p class="truncate font-medium text-foreground">{repository.nameWithOwner}</p>
										<p
											class="truncate font-mono text-xs text-muted-foreground"
											title={repository.target.projectPath}
										>
											{repository.target.projectPath}
										</p>
									</td>
									<td class="px-3 py-2 text-xs text-muted-foreground">
										<p>{executorLabel(repository)}</p>
										{#if repository.viewerLogin}<p>@{repository.viewerLogin}</p>{/if}
									</td>
									<td class="px-3 py-2">
										<Switch
											checked={repository.settings.autoReview}
											onCheckedChange={(next) => setAutoReview(repository, Boolean(next))}
											aria-label={m.pull_request_repository_auto_review_for({
												repository: repository.nameWithOwner,
											})}
										/>
									</td>
									<td class="px-3 py-2 text-xs text-muted-foreground">
										<p class="truncate">{agentLabelFor(repository.target.agentId)}</p>
										<p class="truncate">{repository.target.model}</p>
									</td>
									<td class="px-3 py-2 text-xs text-muted-foreground"
										>{postingLabels[repository.settings.posting]()}</td
									>
									<td class="max-w-40 px-3 py-2 text-xs text-muted-foreground">
										<p class="line-clamp-2" title={repository.scan.message ?? undefined}>
											{scanLabel(repository)}
										</p>
									</td>
									<td class="px-2 py-2">
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
														repository: repository.nameWithOwner,
													})}
													onclick={() => (editing = { repository })}
												>
													<Pencil class="h-4 w-4" />
												</Button>
												<Button
													size="icon-sm"
													variant="ghost"
													aria-label={m.pull_request_repository_disconnect_named({
														repository: repository.nameWithOwner,
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
			<section>
				<h3 class="mb-2 text-sm font-medium text-foreground">
					{m.pull_request_repository_recent_runs()}
				</h3>
				{#if reviews.recentRuns.length === 0}
					<p class="text-sm text-muted-foreground">
						{m.pull_request_repository_recent_runs_empty()}
					</p>
				{:else}
					<ol class="divide-y divide-border rounded-md border border-border" data-pr-run-log>
						{#each reviews.recentRuns.slice(0, 20) as entry (entry.id)}
							{@const chip = reviewRunChip(entry)}
							{@const age = formatRelativeTimestamp(entry.createdAt, currentTime)}
							<li class="flex min-w-0 items-center gap-2 px-3 py-2 text-xs">
								{#if chip}<PullRequestReviewChip {chip} />{/if}
								<span class="min-w-0 flex-1 truncate text-foreground">
									{repositoryName(entry.repositoryId)} #{entry.number} · {entry.title}
								</span>
								{#if entry.message && entry.state !== 'completed'}
									<span
										class="hidden max-w-60 truncate text-muted-foreground sm:inline"
										title={entry.message}
									>
										{entry.message}
									</span>
								{/if}
								{#if age}<time class="shrink-0 text-muted-foreground" datetime={entry.createdAt}
										>{age.label}</time
									>{/if}
								{#if entry.chatId && entry.chatAvailable}
									{@const chatId = entry.chatId}
									<Button size="sm" variant="ghost" onclick={() => onOpenChat(chatId)}>
										{m.pull_request_review_open_chat()}
									</Button>
								{/if}
							</li>
						{/each}
					</ol>
				{/if}
			</section>
		</div>
	</Dialog.Content>
</Dialog.Root>

{#if editing}
	<PullRequestRepositoryDialog
		repository={editing.repository}
		onSave={(input) =>
			editing?.repository ? reviews.update(editing.repository.id, input) : reviews.connect(input)}
		onClose={() => (editing = null)}
	/>
{/if}
