<script lang="ts">
	import { untrack } from 'svelte';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import type { GitPorcelainState } from '$lib/git/workbench/git-porcelain.svelte.js';

	interface GitPorcelainPanelProps {
		projectPath: string;
		selectedFile: string | null;
		porcelain: GitPorcelainState;
	}

	let { projectPath, selectedFile, porcelain }: GitPorcelainPanelProps = $props();
	let pendingConfirmation = $state<
		| { type: 'accept-conflict'; scopeKey: string; filePath: string; side: 'ours' | 'theirs' }
		| { type: 'drop-stash'; scopeKey: string; stashRef: string }
		| null
	>(null);
	let loadKey = $derived(`${projectPath}|${porcelain.inspectorView}|${selectedFile ?? ''}`);
	let title = $derived(
		porcelain.inspectorView === 'conflicts'
			? 'Conflicts'
			: porcelain.inspectorView === 'stash'
				? 'Stash'
				: porcelain.inspectorView === 'history'
					? 'History'
					: porcelain.inspectorView === 'graph'
						? 'Graph'
						: '',
	);
	let activeConfirmation = $derived(
		pendingConfirmation?.scopeKey === loadKey ? pendingConfirmation : null,
	);
	let confirmationLabel = $derived.by(() => {
		if (!activeConfirmation) return '';
		if (activeConfirmation.type === 'accept-conflict') {
			return `Accept ${activeConfirmation.side} for ${activeConfirmation.filePath}? This replaces the working conflict content with that side and stages the file.`;
		}
		return `Drop ${activeConfirmation.stashRef}? This removes the stash entry and cannot be undone from this panel.`;
	});

	$effect(() => {
		loadKey;
		if (!projectPath || porcelain.inspectorView === 'none') {
			untrack(() => porcelain.cancelActiveLoad());
			return;
		}
		untrack(() => void porcelain.loadCurrentView(projectPath));
		return () => porcelain.cancelActiveLoad();
	});

	function requestAcceptConflict(filePath: string, side: 'ours' | 'theirs'): void {
		pendingConfirmation = { type: 'accept-conflict', scopeKey: loadKey, filePath, side };
	}

	function requestDropStash(stashRef: string): void {
		pendingConfirmation = { type: 'drop-stash', scopeKey: loadKey, stashRef };
	}

	async function confirmPendingAction(): Promise<void> {
		const confirmation = activeConfirmation;
		if (!confirmation) return;
		pendingConfirmation = null;
		if (confirmation.type === 'accept-conflict') {
			await porcelain.acceptConflictSide(projectPath, confirmation.filePath, confirmation.side);
			return;
		}
		await porcelain.dropStash(projectPath, confirmation.stashRef);
	}
</script>

{#if porcelain.inspectorView !== 'none'}
	<section class="border-b border-border bg-background">
		<div class="flex items-center justify-between gap-2 px-3 py-2">
			<div class="flex min-w-0 items-center gap-2">
				<span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
					>{title}</span
				>
				{#if porcelain.isLoading}
					<LoaderCircle class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
				{/if}
			</div>
			<button
				type="button"
				class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
				onclick={() => porcelain.loadCurrentView(projectPath)}
				title="Refresh"
				aria-label="Refresh"
			>
				<RefreshCw class="h-3.5 w-3.5" />
			</button>
		</div>

		<div class="max-h-56 overflow-auto px-3 pb-3 text-xs">
			{#if porcelain.inspectorView === 'conflicts'}
				{#if porcelain.conflicts.length === 0}
					<p class="py-3 text-muted-foreground">No conflicts</p>
				{:else}
					<div class="grid gap-2 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
						<div class="space-y-1">
							{#each porcelain.conflicts as conflict}
								<button
									type="button"
									class="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-muted {porcelain
										.conflictDetails?.path === conflict.path
										? 'bg-muted text-foreground'
										: 'text-muted-foreground'}"
									onclick={() => porcelain.selectConflict(projectPath, conflict.path)}
								>
									<span class="truncate font-mono">{conflict.path}</span>
									<span class="shrink-0 text-[10px]">{conflict.status}</span>
								</button>
							{/each}
						</div>
						{#if porcelain.conflictDetails}
							{@const detail = porcelain.conflictDetails}
							<div class="min-w-0 space-y-2">
								<div class="truncate font-mono text-foreground">{detail.path}</div>
								<div class="flex flex-wrap gap-2">
									<button
										type="button"
										class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
										onclick={() => requestAcceptConflict(detail.path, 'ours')}
									>
										Accept ours
									</button>
									<button
										type="button"
										class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
										onclick={() => requestAcceptConflict(detail.path, 'theirs')}
									>
										Accept theirs
									</button>
									<button
										type="button"
										class="rounded bg-interactive-accent px-2 py-1 text-interactive-accent-foreground"
										onclick={() => porcelain.markConflictResolved(projectPath, detail.path)}
									>
										Mark resolved
									</button>
								</div>
								{#if activeConfirmation?.type === 'accept-conflict' && activeConfirmation.filePath === detail.path}
									<div
										class="rounded border border-status-warning-border bg-status-warning/10 p-2 text-status-warning-muted-foreground"
									>
										<div class="mb-2">{confirmationLabel}</div>
										<div class="flex gap-2">
											<button
												type="button"
												class="rounded bg-status-warning px-2 py-1 text-status-warning-foreground"
												onclick={() => void confirmPendingAction()}
											>
												Confirm
											</button>
											<button
												type="button"
												class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
												onclick={() => (pendingConfirmation = null)}
											>
												Cancel
											</button>
										</div>
									</div>
								{/if}
								{#if detail.truncated}
									<div class="rounded border border-border bg-muted/40 p-2 text-muted-foreground">
										One or more conflict versions were truncated because they exceed display limits.
									</div>
								{/if}
								<pre
									class="max-h-24 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">{detail
										.working.content ?? 'Working content exceeds the conflict preview limit.'}</pre>
							</div>
						{/if}
					</div>
				{/if}
			{:else if porcelain.inspectorView === 'stash'}
				<div class="mb-3 flex flex-wrap items-center gap-2">
					<input
						type="text"
						bind:value={porcelain.stashMessage}
						placeholder="Stash message"
						class="min-w-44 flex-1 rounded border border-border bg-muted px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					/>
					<label class="inline-flex items-center gap-1.5 text-muted-foreground">
						<input
							type="checkbox"
							bind:checked={porcelain.stashIncludeUntracked}
							class="size-3 accent-current"
						/>
						<span>Untracked</span>
					</label>
					<button
						type="button"
						class="rounded bg-interactive-accent px-2 py-1 text-interactive-accent-foreground"
						onclick={() => porcelain.createStash(projectPath)}
					>
						Create
					</button>
				</div>
				{#if porcelain.stashes.length === 0}
					<p class="py-3 text-muted-foreground">No stashes</p>
				{:else}
					<div class="space-y-1">
						{#each porcelain.stashes as stash}
							<div class="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted">
								<div class="min-w-0 flex-1">
									<div class="truncate font-mono text-foreground">{stash.ref}</div>
									<div class="truncate text-muted-foreground">{stash.message}</div>
								</div>
								<button
									type="button"
									class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
									onclick={() => porcelain.applyStash(projectPath, stash.ref)}
								>
									Apply
								</button>
								<button
									type="button"
									class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
									onclick={() => porcelain.popStash(projectPath, stash.ref)}
								>
									Pop
								</button>
								<button
									type="button"
									class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-status-error-foreground"
									onclick={() => requestDropStash(stash.ref)}
								>
									Drop
								</button>
							</div>
							{#if activeConfirmation?.type === 'drop-stash' && activeConfirmation.stashRef === stash.ref}
								<div
									class="ml-2 rounded border border-status-warning-border bg-status-warning/10 p-2 text-status-warning-muted-foreground"
								>
									<div class="mb-2">{confirmationLabel}</div>
									<div class="flex gap-2">
										<button
											type="button"
											class="rounded bg-status-warning px-2 py-1 text-status-warning-foreground"
											onclick={() => void confirmPendingAction()}
										>
											Confirm
										</button>
										<button
											type="button"
											class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
											onclick={() => (pendingConfirmation = null)}
										>
											Cancel
										</button>
									</div>
								</div>
							{/if}
						{/each}
					</div>
				{/if}
			{:else if porcelain.inspectorView === 'history'}
				{#if !selectedFile}
					<p class="py-3 text-muted-foreground">Select a file</p>
				{:else}
					<div class="grid gap-3 md:grid-cols-2">
						<div>
							<div class="mb-1 truncate font-mono text-muted-foreground">{selectedFile}</div>
							{#if porcelain.fileHistory.length === 0}
								<p class="py-2 text-muted-foreground">No history</p>
							{:else}
								<div class="space-y-1">
									{#each porcelain.fileHistory.slice(0, 8) as commit}
										<div class="rounded px-2 py-1 hover:bg-muted">
											<div class="truncate text-foreground">{commit.subject}</div>
											<div class="truncate font-mono text-[10px] text-muted-foreground">
												{commit.hash.slice(0, 10)} · {commit.author}
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
						<div>
							<div class="mb-1 text-muted-foreground">
								Blame {porcelain.blameTruncated ? '(truncated)' : ''}
							</div>
							<div class="space-y-1">
								{#each porcelain.blameLines.slice(0, 12) as line}
									<div
										class="grid grid-cols-[3rem_minmax(0,1fr)] gap-2 rounded px-2 py-0.5 hover:bg-muted"
									>
										<span class="text-right font-mono text-muted-foreground">{line.line}</span>
										<span class="truncate font-mono text-foreground">{line.content}</span>
									</div>
								{/each}
							</div>
						</div>
					</div>
				{/if}
			{:else if porcelain.inspectorView === 'graph'}
				<div class="mb-3 flex flex-wrap items-center gap-2">
					<input
						type="text"
						bind:value={porcelain.compareBase}
						class="w-28 rounded border border-border bg-muted px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					/>
					<span class="text-muted-foreground">...</span>
					<input
						type="text"
						bind:value={porcelain.compareHead}
						class="w-28 rounded border border-border bg-muted px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					/>
					<button
						type="button"
						class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
						onclick={() => porcelain.compareRefs(projectPath)}
					>
						Compare
					</button>
				</div>
				{#if porcelain.compareFiles.length > 0}
					<div class="mb-3 space-y-1">
						{#each porcelain.compareFiles as file}
							<div class="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted">
								<span class="w-8 shrink-0 font-mono text-muted-foreground">{file.status}</span>
								<span class="min-w-0 flex-1 truncate font-mono text-foreground">{file.path}</span>
								<span class="text-git-added">+{file.additions}</span>
								<span class="text-git-deleted">-{file.deletions}</span>
							</div>
						{/each}
					</div>
				{/if}
				<div class="space-y-1">
					{#each porcelain.graphCommits.slice(0, 30) as commit}
						<div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-2 rounded px-2 py-1 hover:bg-muted">
							<span class="truncate font-mono text-muted-foreground">{commit.hash.slice(0, 8)}</span
							>
							<span class="truncate text-foreground">{commit.subject}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</section>
{/if}
