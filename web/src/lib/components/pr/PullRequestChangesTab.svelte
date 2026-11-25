<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { PullRequestDiffController } from '$lib/git/pull-requests/pull-request-diff.svelte.js';
	import type { PullRequestFileProgress } from '$lib/git/pull-requests/pull-request-file-progress.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import { DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS } from '$lib/api/git.js';
	import type { PullRequestDetail } from '$lib/api/pull-requests';
	import { buildGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
	import { buildPullRequestVirtualRowSource } from '$lib/git/pull-requests/pull-request-virtual-row-source.js';
	import PullRequestVirtualDiffSurface from './PullRequestVirtualDiffSurface.svelte';

	interface Props {
		detail: PullRequestDetail;
		progress: PullRequestFileProgress;
	}

	let { detail, progress }: Props = $props();
	const diff = new PullRequestDiffController();
	$effect(() => {
		const current = detail;
		untrack(() => diff.open(current));
	});
	onDestroy(() => diff.close());
	const documentId = $derived(diff.documentId ?? detail.documentId);

	const viewedFiles = $derived(progress.viewed);
	const collapsedFiles = $derived(progress.collapsed);
	$effect.pre(() => progress.selectReview(detail));

	const filePaths = $derived(detail.files.map((file) => file.path));
	const allCollapsed = $derived(filePaths.length > 0 && collapsedFiles.size >= filePaths.length);
	const viewedCount = $derived(viewedFiles.size);
	const viewedPercent = $derived(
		filePaths.length ? Math.round((viewedCount / filePaths.length) * 100) : 0,
	);
	const threadsById = $derived(new Map(detail.threads.map((thread) => [thread.id, thread])));
	const threadCountByFile = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const thread of detail.threads)
			counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
		return counts;
	});
	const diffSource = $derived.by(() => {
		const baseSource = buildGitVirtualReviewRowSource({
			summary: {
				documentId,
				project: '',
				context: 3,
				files: detail.files,
				limits: DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS,
			},
			visibleFilePaths: filePaths,
			fileBodies: diff.fileBodies,
			get syntaxResults() {
				return diff.syntax.results;
			},
			get loadingBodies() {
				return diff.loadingBodies;
			},
			focusedFilePath: null,
			diffMode: 'unified',
			contextLines: 3,
			interaction: { kind: 'read-only' },
			collapsedFilePaths: collapsedFiles,
		});
		return buildPullRequestVirtualRowSource({
			baseSource,
			files: detail.files,
			fileBodies: diff.fileBodies,
			threads: detail.threads,
			collapsedFilePaths: collapsedFiles,
		});
	});

	function toggleCollapseAll(): void {
		progress.collapsed = allCollapsed ? new Set() : new Set(filePaths);
	}
</script>

<div class="border-b border-border">
	<div class="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground">
		<span>{m.pull_request_changed_files({ count: detail.files.length })}</span>
		<div class="flex items-center gap-3">
			{#if detail.files.length > 0}
				<button
					type="button"
					class="inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					onclick={toggleCollapseAll}
				>
					{#if allCollapsed}
						<ChevronsUpDown class="h-3.5 w-3.5" />
						{m.common_expand_all()}
					{:else}
						<ChevronsDownUp class="h-3.5 w-3.5" />
						{m.common_collapse_all()}
					{/if}
				</button>
			{/if}
			<span class="tabular-nums"
				>{m.pull_request_viewed_count({ count: viewedCount, total: detail.files.length })}</span
			>
		</div>
	</div>
	<div class="h-0.5 bg-muted">
		<div
			class="h-full bg-git-added transition-all duration-300"
			style:width="{viewedPercent}%"
		></div>
	</div>
</div>
{#if detail.files.length === 0}
	<div class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
		{m.pull_request_no_changes()}
	</div>
{:else}
	<PullRequestVirtualDiffSurface
		{documentId}
		source={diffSource}
		{viewedFiles}
		{collapsedFiles}
		{threadsById}
		{threadCountByFile}
		onToggleViewed={(path) => progress.toggleViewed(path)}
		onToggleCollapsed={(path) => progress.toggleCollapsed(path)}
		onBodyDemand={(demand) =>
			diff.handleDemand({
				...demand,
				filePaths: demand.filePaths.filter((path) => !collapsedFiles.has(path)),
			})}
	/>
{/if}
