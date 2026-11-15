<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import { splitProjectPath } from '$lib/project-paths/compact-project-path';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import * as m from '$lib/paraglide/messages.js';

	let { form }: { form: NewChatFormState } = $props();
	const id = $props.id();
	const worktrees = $derived(form.listedWorktrees);
	const canLoad = $derived(
		form.worktreesAvailable && form.gitRepoStatus === 'git' && form.validationStatus === 'valid',
	);

	$effect(() => {
		form.worktreeContextKey;
		form.nonblankPath;
		const available = form.worktreesAvailable;
		const readyToLoad = canLoad;
		untrack(() => {
			if (!available) form.clearWorktrees();
			else if (!form.hasListedWorktrees) {
				if (readyToLoad) void form.loadWorktrees();
				else form.clearWorktrees();
			}
		});
	});
	onDestroy(() => {
		form.clearWorktrees();
	});
</script>

<section aria-labelledby={id + '-heading'} class="min-w-0 space-y-2" data-slot="new-chat-worktrees">
	<div class="flex items-center justify-between gap-2">
		<h3 id={id + '-heading'} class="text-xs font-medium text-muted-foreground">
			{m.chat_new_chat_worktrees()}
		</h3>
		{#if canLoad}
			<div class="flex items-center gap-3">
				<button
					type="button"
					onclick={() => void form.loadWorktrees()}
					disabled={form.isLoadingWorktrees || form.isCreatingWorktree}
					aria-label={m.workspace_worktree_refresh()}
					class="rounded-md p-1 text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
				>
					<RefreshCw
						class="size-4 {form.isLoadingWorktrees ? 'animate-spin' : ''}"
						aria-hidden="true"
					/>
				</button>
			</div>
		{/if}
	</div>
	{#if !form.executorReady}
		<p role="status" class="text-sm text-muted-foreground">
			{m.chat_new_chat_worktrees_executor_unavailable()}
		</p>
	{:else if !form.nonblankPath}
		<p class="text-sm text-muted-foreground">{m.chat_new_chat_worktrees_choose_project()}</p>
	{:else if form.filesAvailable && form.validationStatus === 'invalid'}
		<p role="status" class="break-all text-sm text-destructive">{form.validationError}</p>
	{:else if !form.worktreesAvailable}
		<p role="status" class="text-sm text-muted-foreground">{m.workspace_git_unavailable()}</p>
	{:else if form.isLoadingWorktrees || (!form.hasListedWorktrees && (form.validationStatus === 'checking' || form.validationStatus === 'idle'))}
		<p role="status" class="text-sm text-muted-foreground">{m.chat_new_chat_worktrees_loading()}</p>
	{:else if form.worktreeError}
		<div role="status" class="flex items-center gap-3 text-sm text-destructive">
			<span>{form.worktreeError}</span><button
				type="button"
				onclick={() => void form.loadWorktrees()}
				class="text-foreground underline">{m.common_retry()}</button
			>
		</div>
	{:else if canLoad || form.hasListedWorktrees}
		{#if worktrees.length > 0}
			<div
				role="radiogroup"
				aria-labelledby={id + '-heading'}
				class="max-h-48 space-y-0.5 overflow-y-auto overscroll-contain"
			>
				{#each worktrees as worktree (worktree.path)}
					{@const pathParts = splitProjectPath(worktree.path)}
					<label
						title={worktree.path}
						class="group flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 py-1 pointer-fine:min-h-8 {form.isSelectedWorktree(
							worktree.path,
						)
							? 'bg-accent text-accent-foreground'
							: 'text-muted-foreground'} {worktree.isPathMissing
							? 'opacity-50'
							: 'cursor-pointer hover:bg-accent/60 hover:text-foreground'}"
					>
						<input
							type="radio"
							name={id + '-worktree'}
							value={worktree.path}
							checked={form.isSelectedWorktree(worktree.path)}
							disabled={worktree.isPathMissing || form.isUpdatingPinnedPath}
							onchange={() => form.selectListedWorktree(worktree.path)}
							class="size-3 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring"
						/>
						<span class="min-w-0 flex-1 text-xs">
							<span class="block truncate">{worktree.branch || worktree.name}</span>
							{#if worktree.isMain}<span class="sr-only">{m.chat_new_chat_worktree_main()}</span
								>{/if}
							<span class="sr-only">{worktree.path}</span>
							{#if worktree.isPathMissing}<span class="sr-only"
									>{m.chat_new_chat_worktree_missing()}</span
								>{/if}
						</span>
						<span
							aria-hidden="true"
							class="min-w-0 max-w-[45%] truncate text-right text-xs text-muted-foreground"
						>
							{pathParts.parent ? '…/' + pathParts.name : pathParts.name}
						</span>
					</label>
				{/each}
			</div>
		{:else}<p role="status" class="text-sm text-muted-foreground">
				{m.chat_new_chat_worktrees_empty()}
			</p>{/if}
	{:else}
		<div class="rounded-md border border-border bg-card p-2 text-xs text-foreground">
			<p class="break-all">{form.nonblankPath}</p>
			<p class="mt-1 text-xs text-muted-foreground">{m.chat_new_chat_worktrees_non_git()}</p>
		</div>
	{/if}
</section>
