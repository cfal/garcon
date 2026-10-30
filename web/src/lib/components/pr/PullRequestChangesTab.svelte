<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import { DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS } from '$lib/api/git.js';
	import type { PullRequestDetail } from '$lib/api/pull-requests';
	import { buildGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
	import { buildPullRequestVirtualRowSource } from '$lib/git/pull-requests/pull-request-virtual-row-source.js';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { cn } from '$lib/utils/cn.js';
	import type { ContainerPresentation } from '$lib/components/shared/container-presentation.js';
	import { fileStatusClass, fileStatusLabel, splitFilePath } from './pr-display.js';
	import PullRequestVirtualDiffSurface from './PullRequestVirtualDiffSurface.svelte';

	interface Props {
		detail: PullRequestDetail;
		// Narrow tabs drop their line totals, so the toolbar shows them instead.
		presentation: ContainerPresentation;
	}

	let { detail, presentation }: Props = $props();

	let viewedFiles = $state<Set<string>>(new Set());
	let collapsedFiles = $state<Set<string>>(new Set());
	let scrollRequest = $state<{ filePath: string; token: number } | null>(null);
	let scrollToken = 0;

	// Resets per-PR view state whenever the shown pull request changes.
	let trackedNumber = $state<number | null>(null);
	$effect(() => {
		const current = detail.number;
		if (current !== trackedNumber) {
			trackedNumber = current;
			viewedFiles = new Set();
			collapsedFiles = new Set();
			scrollRequest = null;
		}
	});

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
				documentId: detail.documentId,
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

	function jumpToFile(filePath: string): void {
		scrollToken += 1;
		scrollRequest = { filePath, token: scrollToken };
	}

	const toolbarButtonClass =
		'inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:px-1.5 pointer-coarse:py-1.5';
</script>

<div class="@container border-b border-border">
	<div class="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground">
		<div class="flex min-w-0 items-center gap-2">
			{#if detail.files.length > 0}
				<DropdownMenu>
					<DropdownMenuTrigger
						class={toolbarButtonClass}
						aria-label={`${m.pull_request_jump_to_file()}, ${m.pull_request_changed_files({ count: detail.files.length })}`}
						data-pr-file-jump
					>
						<span class="truncate"
							>{m.pull_request_changed_files({ count: detail.files.length })}</span
						>
						<ChevronDown class="h-3.5 w-3.5 shrink-0" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" class="w-[min(24rem,calc(100vw-1.5rem))]">
						{#each detail.files as file (file.path)}
							{@const parts = splitFilePath(file.path)}
							<DropdownMenuItem
								onSelect={() => jumpToFile(file.path)}
								data-pr-file-jump-item={file.path}
							>
								<Check
									class={cn(
										'shrink-0',
										viewedFiles.has(file.path) ? 'text-git-added' : 'invisible',
									)}
								/>
								{#if viewedFiles.has(file.path)}<span class="sr-only"
										>{m.pull_request_viewed()}</span
									>{/if}
								<span
									class={cn(
										'shrink-0 text-[10px] font-semibold',
										fileStatusClass(file.workTreeStatus),
									)}
									title={fileStatusLabel(file.workTreeStatus)}>{file.workTreeStatus}</span
								>
								<span class="flex min-w-0 flex-1 font-mono text-xs" title={file.path}>
									<span class="min-w-0 truncate text-muted-foreground">{parts.directory}</span><span
										class="max-w-full shrink-0 truncate">{parts.baseName}</span
									>
								</span>
								<span class="shrink-0 text-[11px] tabular-nums">
									<span class="text-git-added">+{file.additions}</span>
									<span class="text-git-deleted">-{file.deletions}</span>
								</span>
							</DropdownMenuItem>
						{/each}
					</DropdownMenuContent>
				</DropdownMenu>
			{:else}
				<span>{m.pull_request_changed_files({ count: 0 })}</span>
			{/if}
			{#if presentation === 'narrow'}
				<span class="shrink-0 tabular-nums" data-pr-line-totals>
					<span class="text-git-added">+{detail.additions.toLocaleString()}</span>
					<span class="text-git-deleted">−{detail.deletions.toLocaleString()}</span>
				</span>
			{/if}
		</div>
		<div class="flex shrink-0 items-center gap-2">
			{#if detail.files.length > 0}
				<!-- Narrow toolbars keep the icon and move the label to assistive text. -->
				<button type="button" class={toolbarButtonClass} onclick={toggleCollapseAll}>
					{#if allCollapsed}
						<ChevronsUpDown class="h-3.5 w-3.5 shrink-0" />
						<span class="@max-md:sr-only">{m.common_expand_all()}</span>
					{:else}
						<ChevronsDownUp class="h-3.5 w-3.5 shrink-0" />
						<span class="@max-md:sr-only">{m.common_collapse_all()}</span>
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
		documentId={detail.documentId}
		source={diffSource}
		{viewedFiles}
		{collapsedFiles}
		{threadsById}
		{threadCountByFile}
		scrollToRequest={scrollRequest}
		onToggleViewed={toggleViewed}
		onToggleCollapsed={toggleCollapsed}
	/>
{/if}
