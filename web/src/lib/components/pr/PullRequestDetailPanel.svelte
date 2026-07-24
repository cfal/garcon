<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import { DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS } from '$lib/api/git.js';
	import type { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
	import type { PullRequestThread } from '$lib/api/pull-requests';
	import { buildGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
	import { buildPullRequestVirtualRowSource } from '$lib/git/pull-requests/pull-request-virtual-row-source.js';
	import PullRequestHeader from './PullRequestHeader.svelte';
	import PullRequestVirtualDiffSurface from './PullRequestVirtualDiffSurface.svelte';
	import { buildAddressThreadPrompt, buildReviewPrompt } from './pr-agent-prompts';

	interface PullRequestDetailPanelProps {
		controller: PullRequestsStore;
		onSendToChat: (message: string) => Promise<boolean>;
		onClose: () => void;
		onAfterSend?: () => void;
	}

	let {
		controller: pullRequests,
		onSendToChat,
		onClose,
		onAfterSend,
	}: PullRequestDetailPanelProps = $props();
	const detail = $derived(pullRequests.detail);
	const isLoading = $derived(pullRequests.isDetailLoading);
	const error = $derived(pullRequests.detailError);

	let isReviewing = $state(false);
	let viewedFiles = $state<Set<string>>(new Set());
	let collapsedFiles = $state<Set<string>>(new Set());

	// Resets per-PR view state whenever the selected PR changes.
	let trackedNumber = $state<number | null>(null);
	$effect(() => {
		const current = detail?.number ?? null;
		if (current !== trackedNumber) {
			trackedNumber = current;
			viewedFiles = new Set();
			collapsedFiles = new Set();
		}
	});

	const filePaths = $derived(detail?.files.map((file) => file.path) ?? []);
	const allCollapsed = $derived(filePaths.length > 0 && collapsedFiles.size >= filePaths.length);
	const viewedCount = $derived(viewedFiles.size);
	const viewedPercent = $derived(
		filePaths.length ? Math.round((viewedCount / filePaths.length) * 100) : 0,
	);
	const threadsById = $derived(
		new Map((detail?.threads ?? []).map((thread) => [thread.id, thread])),
	);
	const threadCountByFile = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const thread of detail?.threads ?? []) {
			counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
		}
		return counts;
	});
	const diffSource = $derived.by(() => {
		if (!detail) return null;
		const baseSource = buildGitVirtualReviewRowSource({
			summary: {
				documentId: `pr:${detail.number}:${detail.updatedAt}`,
				project: '',
				context: 3,
				files: detail.files,
				limits: DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS,
			},
			visibleFilePaths: detail.files.map((file) => file.path),
			fileBodies: detail.fileBodies,
			loadingBodies: new Set<string>(),
			focusedFilePath: null,
			diffMode: 'unified',
			contextLines: 3,
			interaction: { kind: 'read-only' },
			collapsedFilePaths: collapsedFiles,
		});
		return buildPullRequestVirtualRowSource({
			baseSource,
			files: detail.files,
			fileBodies: detail.fileBodies,
			threads: detail.threads,
			collapsedFilePaths: collapsedFiles,
		});
	});

	async function handleReview(): Promise<void> {
		if (!detail) return;
		isReviewing = true;
		try {
			const sent = await onSendToChat(buildReviewPrompt(detail));
			if (sent) onAfterSend?.();
		} finally {
			isReviewing = false;
		}
	}

	async function handleAddressThread(thread: PullRequestThread): Promise<void> {
		if (!detail) return;
		const sent = await onSendToChat(buildAddressThreadPrompt(detail, thread));
		if (sent) onAfterSend?.();
	}

	// Marking a file viewed also collapses it; un-viewing re-expands it.
	function toggleViewed(path: string): void {
		const nextViewed = new Set(viewedFiles);
		const nextCollapsed = new Set(collapsedFiles);
		if (nextViewed.has(path)) {
			nextViewed.delete(path);
			nextCollapsed.delete(path);
		} else {
			nextViewed.add(path);
			nextCollapsed.add(path);
		}
		viewedFiles = nextViewed;
		collapsedFiles = nextCollapsed;
	}

	function toggleCollapsed(path: string): void {
		const next = new Set(collapsedFiles);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		collapsedFiles = next;
	}

	function toggleCollapseAll(): void {
		collapsedFiles = allCollapsed ? new Set() : new Set(filePaths);
	}

	function handleRefresh(): void {
		const number = detail?.number ?? pullRequests.selectedNumber;
		if (number !== null) void pullRequests.loadDetail(number);
	}
</script>

<div class="flex h-full flex-col bg-background">
	{#if detail}
		<PullRequestHeader
			pr={detail}
			{isReviewing}
			onReview={handleReview}
			onRefresh={handleRefresh}
			{onClose}
		/>
		<div class="border-b border-border">
			<div class="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground">
				<span>{detail.files.length} file{detail.files.length === 1 ? '' : 's'} changed</span>
				<div class="flex items-center gap-3">
					{#if detail.files.length > 0}
						<button
							type="button"
							class="inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							onclick={toggleCollapseAll}
						>
							{#if allCollapsed}
								<ChevronsUpDown class="h-3.5 w-3.5" />
								Expand all
							{:else}
								<ChevronsDownUp class="h-3.5 w-3.5" />
								Collapse all
							{/if}
						</button>
					{/if}
					<span class="tabular-nums">{viewedCount}/{detail.files.length} viewed</span>
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
				This pull request has no file changes.
			</div>
		{:else if diffSource}
			<PullRequestVirtualDiffSurface
				documentId={`pr:${detail.number}:${detail.updatedAt}`}
				source={diffSource}
				{viewedFiles}
				{collapsedFiles}
				{threadsById}
				{threadCountByFile}
				onToggleViewed={toggleViewed}
				onToggleCollapsed={toggleCollapsed}
				onAddressThread={handleAddressThread}
			/>
		{/if}
	{:else if isLoading}
		<div class="flex h-full items-center justify-center text-muted-foreground">
			<LoaderCircle class="h-5 w-5 animate-spin" />
		</div>
	{:else if error}
		<div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
			<TriangleAlert class="h-6 w-6 text-git-deleted" />
			<p class="text-sm text-muted-foreground">{error}</p>
			<button
				type="button"
				class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				onclick={handleRefresh}
			>
				Retry
			</button>
		</div>
	{/if}
</div>
