<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Copy from '@lucide/svelte/icons/copy';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import type { GitHistoryCommitListItem } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitCommitListRowProps {
		commit: GitHistoryCommitListItem;
		comparisonSelectionActive: boolean;
		comparisonSelectionSlot: 'from' | 'to';
		selectedForComparison: boolean;
		active: boolean;
		onActivate: () => void;
		onOpenOrSelect: () => void;
		onNavigate: (event: KeyboardEvent) => void;
		onFocusWithinChange: (focused: boolean) => void;
	}

	let {
		commit,
		comparisonSelectionActive,
		comparisonSelectionSlot,
		selectedForComparison,
		active,
		onActivate,
		onOpenOrSelect,
		onNavigate,
		onFocusWithinChange,
	}: GitCommitListRowProps = $props();

	let copied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | null = null;

	function formatDate(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		}).format(date);
	}

	async function copyCommitHash(event: MouseEvent): Promise<void> {
		event.stopPropagation();
		await navigator.clipboard?.writeText(commit.hash);
		copied = true;
		if (copyTimeout) clearTimeout(copyTimeout);
		copyTimeout = setTimeout(() => {
			copied = false;
		}, 1_200);
	}

	function handleFocusIn(): void {
		onActivate();
		onFocusWithinChange(true);
	}

	function handleFocusOut(event: FocusEvent & { currentTarget: HTMLDivElement }): void {
		if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
			return;
		onFocusWithinChange(false);
	}

	$effect(() => {
		return () => {
			if (copyTimeout) clearTimeout(copyTimeout);
		};
	});
</script>

<div
	class="group relative cursor-pointer select-none px-3 py-2 hover:bg-muted/40 {selectedForComparison
		? 'bg-interactive-accent/10'
		: ''}"
	data-git-history-commit-hash={commit.hash}
	onpointerdown={onActivate}
	onfocusin={handleFocusIn}
	onfocusout={handleFocusOut}
>
	<button
		type="button"
		class="absolute inset-0 z-0 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
		tabindex={active ? 0 : -1}
		aria-pressed={comparisonSelectionActive ? selectedForComparison : undefined}
		aria-label={comparisonSelectionActive
			? m.git_compare_select_commit_for({
					commit: commit.subject || commit.shortHash,
					endpoint: comparisonSelectionSlot === 'from' ? m.git_compare_from() : m.git_compare_to(),
				})
			: m.git_history_open_commit({
					commit: commit.subject || commit.shortHash,
				})}
		data-git-history-commit-row
		onclick={onOpenOrSelect}
		onkeydown={onNavigate}
	></button>
	<div class="pointer-events-none relative z-[1] flex items-stretch gap-2">
		<div class="min-w-0 flex-1 text-left">
			<div class="flex min-w-0 items-center gap-2">
				<span class="min-w-0 truncate text-sm font-medium text-foreground">
					{commit.subject || commit.shortHash}
				</span>
				{#if commit.parents.length > 1}
					<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
						merge
					</span>
				{/if}
			</div>
			<div
				class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
			>
				<span class="truncate">{commit.author}</span>
				<span>{formatDate(commit.authorDate)}</span>
				<span class="font-mono">{commit.shortHash}</span>
				{#if commit.refs.length > 0}
					<span class="inline-flex min-w-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5">
						<GitBranch class="h-3 w-3 shrink-0" />
						<span class="truncate">{commit.refs.join(', ')}</span>
					</span>
				{/if}
			</div>
		</div>
		<button
			type="button"
			class="pointer-events-auto self-center rounded p-1 text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			tabindex={active ? 0 : -1}
			title={copied ? 'Copied commit hash' : 'Copy commit hash'}
			aria-label={copied ? 'Copied commit hash' : 'Copy commit hash'}
			onclick={copyCommitHash}
		>
			<Copy class="h-3.5 w-3.5" />
		</button>
		<ChevronRight class="self-center h-4 w-4 shrink-0 text-muted-foreground" />
	</div>
</div>
