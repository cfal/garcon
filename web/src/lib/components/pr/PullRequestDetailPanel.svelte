<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { getPullRequests } from '$lib/context';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import type { PullRequestThread } from '$lib/api/pull-requests';
	import PullRequestHeader from './PullRequestHeader.svelte';
	import PullRequestFileDiff from './PullRequestFileDiff.svelte';
	import { buildAddressThreadPrompt, buildReviewPrompt } from './pr-agent-prompts';

	interface PullRequestDetailPanelProps {
		onSendToChat: (message: string) => Promise<boolean>;
		onClose: () => void;
	}

	let { onSendToChat, onClose }: PullRequestDetailPanelProps = $props();

	const pullRequests = getPullRequests();
	const detail = $derived(pullRequests.detail);
	const isLoading = $derived(pullRequests.isDetailLoading);
	const error = $derived(pullRequests.detailError);

	let isReviewing = $state(false);
	let viewedFiles = $state<Set<string>>(new Set());

	// Resets the per-file "viewed" set whenever the selected PR changes.
	let trackedNumber = $state<number | null>(null);
	$effect(() => {
		const current = detail?.number ?? null;
		if (current !== trackedNumber) {
			trackedNumber = current;
			viewedFiles = new Set();
		}
	});

	const threadsByFile = $derived.by(() => {
		const map = new Map<string, PullRequestThread[]>();
		for (const thread of detail?.threads ?? []) {
			const list = map.get(thread.path) ?? [];
			list.push(thread);
			map.set(thread.path, list);
		}
		return map;
	});

	async function handleReview(): Promise<void> {
		if (!detail) return;
		isReviewing = true;
		try {
			await onSendToChat(buildReviewPrompt(detail));
		} finally {
			isReviewing = false;
		}
	}

	function handleAddressThread(thread: PullRequestThread): void {
		if (!detail) return;
		void onSendToChat(buildAddressThreadPrompt(detail, thread));
	}

	function toggleViewed(path: string): void {
		const next = new Set(viewedFiles);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		viewedFiles = next;
	}

	function handleRefresh(): void {
		if (detail) void pullRequests.loadDetail(detail.number);
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
		<div
			class="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
		>
			<span>{detail.files.length} file{detail.files.length === 1 ? '' : 's'} changed</span>
			<span>{viewedFiles.size}/{detail.files.length} viewed</span>
		</div>
		<ScrollArea class="min-h-0 flex-1">
			<div class="space-y-2 p-3">
				{#if detail.body.trim()}
					<div
						class="whitespace-pre-wrap break-words rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground"
					>
						{detail.body}
					</div>
				{/if}
				{#if detail.files.length === 0}
					<div class="py-8 text-center text-sm text-muted-foreground">
						This pull request has no file changes.
					</div>
				{:else}
					{#each detail.files as file (file.path)}
						<svelte:boundary>
							<PullRequestFileDiff
								{file}
								body={detail.fileBodies[file.path]}
								threads={threadsByFile.get(file.path) ?? []}
								viewed={viewedFiles.has(file.path)}
								onToggleViewed={() => toggleViewed(file.path)}
								onAddressThread={handleAddressThread}
							/>
							{#snippet failed(err)}
								<div class="rounded-md border border-border px-3 py-2 text-xs text-git-deleted">
									Failed to render {file.path}: {err instanceof Error ? err.message : 'unknown error'}
								</div>
							{/snippet}
						</svelte:boundary>
					{/each}
				{/if}
			</div>
		</ScrollArea>
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
