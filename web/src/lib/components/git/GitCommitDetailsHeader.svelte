<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Copy from '@lucide/svelte/icons/copy';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import type { GitCommitSnapshotReady } from '$lib/api/git.js';

	interface GitCommitDetailsHeaderProps {
		snapshot: GitCommitSnapshotReady;
		onBack: () => void;
		onSelectParent: (parentHash: string | null) => void;
		onRevertCommit: () => void;
	}

	let { snapshot, onBack, onSelectParent, onRevertCommit }: GitCommitDetailsHeaderProps = $props();

	let copied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | null = null;

	let additions = $derived(snapshot.files.reduce((sum, file) => sum + file.additions, 0));
	let deletions = $derived(snapshot.files.reduce((sum, file) => sum + file.deletions, 0));
	let fullMessage = $derived.by(() => {
		const body = snapshot.commit.body.trim();
		return body ? `${snapshot.commit.subject}\n\n${body}` : snapshot.commit.subject;
	});
	let committerVisible = $derived(
		snapshot.commit.committer !== snapshot.commit.author ||
			snapshot.commit.committerEmail !== snapshot.commit.authorEmail,
	);

	function formatDate(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(date);
	}

	async function copyHash(): Promise<void> {
		await navigator.clipboard?.writeText(snapshot.commit.hash);
		copied = true;
		if (copyTimeout) clearTimeout(copyTimeout);
		copyTimeout = setTimeout(() => {
			copied = false;
		}, 1200);
	}
</script>

<div class="border-b border-border bg-background px-3 py-2">
	<div class="flex min-w-0 items-start gap-2">
		<button
			type="button"
			class="mt-0.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			aria-label="Back to commit history"
			title="Back to commit history"
			onclick={onBack}
		>
			<ArrowLeft class="h-4 w-4" />
		</button>
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				<h3 class="min-w-0 truncate text-sm font-semibold text-foreground">
					{snapshot.commit.subject || snapshot.commit.shortHash}
				</h3>
				<span class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
					{snapshot.commit.shortHash}
				</span>
				<button
					type="button"
					class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					title={copied ? 'Copied commit hash' : 'Copy commit hash'}
					aria-label={copied ? 'Copied commit hash' : 'Copy commit hash'}
					onclick={copyHash}
				>
					<Copy class="h-3.5 w-3.5" />
				</button>
			</div>
			<div
				class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
			>
				<span>{snapshot.commit.author}</span>
				<span>{formatDate(snapshot.commit.authorDate)}</span>
				{#if committerVisible}
					<span>committed by {snapshot.commit.committer}</span>
				{/if}
				{#if snapshot.commit.refs.length > 0}
					<span class="inline-flex min-w-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5">
						<GitBranch class="h-3 w-3 shrink-0" />
						<span class="truncate">{snapshot.commit.refs.join(', ')}</span>
					</span>
				{/if}
			</div>
			{#if snapshot.commit.body.trim()}
				<details class="mt-2 text-xs text-muted-foreground">
					<summary class="cursor-pointer select-none text-foreground">Full message</summary>
					<pre class="mt-1 whitespace-pre-wrap break-words font-sans">{fullMessage}</pre>
				</details>
			{/if}
		</div>
	</div>

	<div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
		<div class="flex min-w-0 flex-wrap items-center gap-2">
			<span>{snapshot.files.length} changed files</span>
			<span class="text-git-added">+{additions}</span>
			<span class="text-git-deleted">-{deletions}</span>
			{#if snapshot.parentOptions.length > 1}
				<label class="inline-flex items-center gap-1">
					<span>Diff against</span>
					<select
						class="rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
						value={snapshot.selectedParent ?? ''}
						onchange={(event) => onSelectParent(event.currentTarget.value || null)}
					>
						{#each snapshot.parentOptions as parent}
							<option value={parent.hash}>{parent.label} {parent.shortHash}</option>
						{/each}
					</select>
				</label>
			{/if}
		</div>
		<button
			type="button"
			class="inline-flex items-center gap-1.5 rounded border border-status-warning-border px-2.5 py-1 text-xs font-medium text-status-warning hover:bg-status-warning/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			onclick={onRevertCommit}
		>
			<Undo2 class="h-3.5 w-3.5" />
			Revert
		</button>
	</div>
</div>
