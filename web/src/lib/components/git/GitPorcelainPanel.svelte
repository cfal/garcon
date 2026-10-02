<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import type { GitProjectTarget } from '$lib/api/git-client.js';
	import type { GitStashTarget } from '$lib/api/git.js';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import type { GitPorcelainState } from '$lib/git/workbench/git-porcelain.svelte.js';
	import { nativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';

	interface GitPorcelainPanelProps {
		project: GitProjectTarget;
		selectedFile: string | null;
		porcelain: GitPorcelainState;
	}

	let { project, selectedFile, porcelain }: GitPorcelainPanelProps = $props();
	let pendingConfirmation = $state<
		| { type: 'accept-conflict'; scopeKey: string; filePath: string; side: 'ours' | 'theirs' }
		| { type: 'drop-stash'; scopeKey: string; stash: GitStashTarget }
		| null
	>(null);
	let loadKey = $derived(
		JSON.stringify([project.executorId, project.projectPath, porcelain.inspectorView, selectedFile]),
	);
	let confirmationKey = $derived(JSON.stringify([loadKey, porcelain.confirmationScope]));
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
		pendingConfirmation?.scopeKey === confirmationKey ? pendingConfirmation : null,
	);
	let confirmationLabel = $derived.by(() => {
		if (!activeConfirmation) return '';
		if (activeConfirmation.type === 'accept-conflict') {
			return `Accept ${activeConfirmation.side} for ${activeConfirmation.filePath}? This replaces the working conflict content with that side and stages the file.`;
		}
		return `Drop ${activeConfirmation.stash.ref}? This removes the stash entry and cannot be undone from this panel.`;
	});
	const contextualScrollRegion = nativeWorkspaceScrollRegion('contextual');

	$effect(() => {
		loadKey;
		if (!project || porcelain.inspectorView === 'none') {
			untrack(() => porcelain.cancelActiveLoad());
			return;
		}
		untrack(() => void porcelain.loadCurrentView(project));
		return () => porcelain.cancelActiveLoad();
	});

	function requestAcceptConflict(filePath: string, side: 'ours' | 'theirs'): void {
		pendingConfirmation = { type: 'accept-conflict', scopeKey: confirmationKey, filePath, side };
	}

	function requestDropStash(stash: GitStashTarget): void {
		pendingConfirmation = {
			type: 'drop-stash',
			scopeKey: confirmationKey,
			stash: { ref: stash.ref, hash: stash.hash },
		};
	}

	function isPendingDrop(stash: GitStashTarget): boolean {
		return (
			activeConfirmation?.type === 'drop-stash' &&
			activeConfirmation.stash.ref === stash.ref &&
			activeConfirmation.stash.hash === stash.hash
		);
	}

	async function confirmPendingAction(): Promise<void> {
		const confirmation = activeConfirmation;
		if (!confirmation) return;
		pendingConfirmation = null;
		if (confirmation.type === 'accept-conflict') {
			await porcelain.acceptConflictSide(project, confirmation.filePath, confirmation.side);
			return;
		}
		await porcelain.dropStash(project, confirmation.stash);
	}

	let recoveringRender = $state(false);
	let mountedRenderReset: (() => void) | null = null;

	// Reloads before resetting, since unchanged data would fail again. Each failure's reset works
	// only once and is replaced when rendering fails again, so recovery is single-flight and
	// resets whichever fallback is still mounted when the reload settles.
	async function recoverRender(): Promise<void> {
		if (recoveringRender) return;
		recoveringRender = true;
		try {
			await porcelain.loadCurrentView(project);
		} finally {
			recoveringRender = false;
		}
		mountedRenderReset?.();
	}

	function trackRenderReset(reset: () => void): Attachment {
		return () => {
			mountedRenderReset = reset;
			return () => {
				if (mountedRenderReset === reset) mountedRenderReset = null;
			};
		};
	}
</script>

{#if porcelain.inspectorView !== 'none'}
	<svelte:boundary>
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
					onclick={() => porcelain.loadCurrentView(project)}
					title={m.common_refresh()}
					aria-label={m.common_refresh()}
				>
					<RefreshCw class="h-3.5 w-3.5" />
				</button>
			</div>

			<div class="max-h-56 overflow-auto px-3 pb-3 text-xs" {@attach contextualScrollRegion}>
				{#if porcelain.inspectorView === 'conflicts'}
					{#if porcelain.conflicts.length === 0}
						<p class="py-3 text-muted-foreground">{m.git_conflicts_none()}</p>
					{:else}
						<div class="grid gap-2 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
							<div class="space-y-1">
								{#each porcelain.conflicts as conflict (conflict.path)}
									<button
										type="button"
										class="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-muted {porcelain
											.conflictDetails?.path === conflict.path
											? 'bg-muted text-foreground'
											: 'text-muted-foreground'}"
										onclick={() => porcelain.selectConflict(project, conflict.path)}
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
											{m.git_conflicts_accept_ours()}
										</button>
										<button
											type="button"
											class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
											onclick={() => requestAcceptConflict(detail.path, 'theirs')}
										>
											{m.git_conflicts_accept_theirs()}
										</button>
										<button
											type="button"
											class="rounded bg-interactive-accent px-2 py-1 text-interactive-accent-foreground"
											onclick={() => porcelain.markConflictResolved(project, detail.path)}
										>
											{m.git_conflicts_mark_resolved()}
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
													{m.common_confirm()}
												</button>
												<button
													type="button"
													class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
													onclick={() => (pendingConfirmation = null)}
												>
													{m.common_cancel()}
												</button>
											</div>
										</div>
									{/if}
									{#if detail.truncated}
										<div class="rounded border border-border bg-muted/40 p-2 text-muted-foreground">
											{m.git_conflicts_truncated()}
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
							placeholder={m.git_stash_message()}
							class="min-w-44 flex-1 rounded border border-border bg-muted px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
						/>
						<label class="inline-flex items-center gap-1.5 text-muted-foreground">
							<input
								type="checkbox"
								bind:checked={porcelain.stashIncludeUntracked}
								class="size-3 accent-current"
							/>
							<span>{m.git_changes_untracked()}</span>
						</label>
						<button
							type="button"
							class="rounded bg-interactive-accent px-2 py-1 text-interactive-accent-foreground"
							onclick={() => porcelain.createStash(project)}
						>
							{m.common_create()}
						</button>
					</div>
					{#if porcelain.stashes.length === 0}
						<p class="py-3 text-muted-foreground">{m.git_stash_none()}</p>
					{:else}
						<div class="space-y-1">
							{#each porcelain.stashes as stash (stash.ref)}
								<div class="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted">
									<div class="min-w-0 flex-1">
										<div class="truncate font-mono text-foreground">{stash.ref}</div>
										<div class="truncate text-muted-foreground">{stash.message}</div>
									</div>
									<button
										type="button"
										class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
										onclick={() => porcelain.applyStash(project, stash)}
									>
										{m.git_stash_apply()}
									</button>
									<button
										type="button"
										class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
										onclick={() => porcelain.popStash(project, stash)}
									>
										{m.git_stash_pop()}
									</button>
									<button
										type="button"
										class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-status-error-foreground"
										onclick={() => requestDropStash(stash)}
									>
										{m.git_stash_drop()}
									</button>
								</div>
								{#if isPendingDrop(stash)}
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
												{m.common_confirm()}
											</button>
											<button
												type="button"
												class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
												onclick={() => (pendingConfirmation = null)}
											>
												{m.common_cancel()}
											</button>
										</div>
									</div>
								{/if}
							{/each}
						</div>
					{/if}
				{:else if porcelain.inspectorView === 'history'}
					{#if !selectedFile}
						<p class="py-3 text-muted-foreground">{m.git_history_select_file()}</p>
					{:else}
						<div class="grid gap-3 md:grid-cols-2">
							<div>
								<div class="mb-1 truncate font-mono text-muted-foreground">{selectedFile}</div>
								{#if porcelain.fileHistory.length === 0}
									<p class="py-2 text-muted-foreground">{m.git_history_none()}</p>
								{:else}
									<div class="space-y-1">
										{#each porcelain.fileHistory.slice(0, 8) as commit (commit.hash)}
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
									{m.git_history_blame()} {porcelain.blameTruncated ? '(truncated)' : ''}
								</div>
								<div class="space-y-1">
									{#each porcelain.blameLines.slice(0, 12) as line (line.line)}
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
					<div class="space-y-1">
						{#each porcelain.graphCommits.slice(0, 30) as commit (commit.hash)}
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
		{#snippet failed(_error, reset)}
			<section
				class="border-b border-border bg-background px-3 py-2 text-xs"
				role="alert"
				{@attach trackRenderReset(reset)}
			>
				<p class="text-status-error-foreground">{m.git_panel_failed({ title })}</p>
				<div class="mt-2 flex gap-2">
					<button
						type="button"
						class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
						disabled={recoveringRender}
						onclick={() => void recoverRender()}
					>
						{m.common_refresh()}
					</button>
					<button
						type="button"
						class="rounded bg-muted px-2 py-1 text-muted-foreground hover:text-foreground"
						onclick={() => porcelain.closeInspector()}
					>
						{m.common_close()}
					</button>
				</div>
			</section>
		{/snippet}
	</svelte:boundary>
{/if}
