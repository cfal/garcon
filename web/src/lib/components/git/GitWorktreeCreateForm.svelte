<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import type { GitWorktreeCreation, GitWorktreeItem } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';
	import { deriveWorktreePath } from '$lib/utils/worktree-path.js';
	import type { WorktreeCreateResult } from '$lib/git/targets/worktree-picker-session.svelte.js';
	import GitNameField from './GitNameField.svelte';

	interface Props {
		worktrees: GitWorktreeItem[];
		showAdvanced: boolean;
		contextKey: string;
		description: string;
		isCreating: boolean;
		canUseGit: boolean;
		result: WorktreeCreateResult | null;
		onBack: () => void;
		onCreate: (creation: GitWorktreeCreation) => void;
	}
	let {
		worktrees,
		showAdvanced = $bindable(),
		contextKey,
		description,
		isCreating,
		canUseGit,
		result,
		onBack,
		onCreate,
	}: Props = $props();
	let branchName = $state('');
	let pathOverride = $state('');
	let baseRefOverride = $state('');
	let suggested = $state(false);
	let generating = $state(false);
	let nameInput = $state<HTMLInputElement | null>(null);
	const repositoryPath = $derived(worktrees.find((worktree) => worktree.isMain)?.path ?? '');
	const defaultPath = $derived(deriveWorktreePath(repositoryPath, branchName));
	const effectivePath = $derived(pathOverride.trim() ? pathOverride : defaultPath);
	const name = $derived(branchName.trim());
	const baseRef = $derived(baseRefOverride.trim() || undefined);
	const created = $derived(result !== null && 'createdPath' in result);
	const readOnly = $derived(isCreating || created);
	const canCreate = $derived(Boolean(name && effectivePath) && canUseGit && !readOnly && !generating);
	const currentBranch = $derived(worktrees.find((worktree) => worktree.isCurrent)?.branch);
	const defaultBase = $derived(currentBranch && currentBranch !== '(detached)' ? currentBranch : 'HEAD');
	const id = $props.id();
	const fieldClass =
		'h-10 w-full rounded-md border border-border bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm';

	$effect(() => {
		nameInput?.focus();
	});

	function create() {
		if (!canCreate) return;
		onCreate({
			worktreePath: effectivePath,
			...(suggested ? { newBranch: name } : { branch: name }),
			baseRef,
		});
	}
</script>

<form
	class="flex min-h-0 flex-1 flex-col"
	onsubmit={(e) => {
		e.preventDefault();
		create();
	}}
>
	<div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
		<GitNameField
			name={branchName}
			bind:ref={nameInput}
			bind:generating
			{contextKey}
			{description}
			disabled={readOnly}
			placeholder={m.workspace_worktree_branch_name_placeholder()}
			onChange={(value, origin) => {
				branchName = value;
				suggested = origin === 'suggested';
			}}
			onEnter={create}
		/>
		{#if !showAdvanced}
			<dl class="grid gap-y-2 text-xs">
				{#if effectivePath || name}
					<div class="space-y-1">
						<dt class="text-muted-foreground">{m.git_worktree_location()}</dt>
						<dd class="wrap-anywhere font-mono">{effectivePath || m.git_worktree_choose_location()}</dd>
					</div>
				{/if}
				<div class="flex flex-wrap items-baseline gap-x-2">
					<dt class="text-muted-foreground">{m.git_worktree_new_branch_base()}</dt>
					<dd class="wrap-anywhere font-mono">{baseRef ?? defaultBase}</dd>
				</div>
			</dl>
		{/if}
		<button
			type="button"
			class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			aria-expanded={showAdvanced}
			onclick={() => (showAdvanced = !showAdvanced)}
		>
			<ChevronRight class="size-4 {showAdvanced ? 'rotate-90' : ''}" />
			{m.git_worktree_advanced()}
		</button>
		{#if showAdvanced}
			<div class="grid gap-3">
				<label for={id + '-path'} class="grid gap-1.5 text-sm">
					{m.git_worktree_location()}
					<input
						id={id + '-path'}
						bind:value={pathOverride}
						readonly={readOnly}
						placeholder={defaultPath || m.workspace_worktree_path_override_placeholder()}
						class={fieldClass}
					/>
				</label>
				<label for={id + '-base'} class="grid gap-1.5 text-sm">
					{m.git_worktree_base_ref()}
					<input
						id={id + '-base'}
						bind:value={baseRefOverride}
						readonly={readOnly}
						placeholder={m.workspace_worktree_base_ref_placeholder()}
						class={fieldClass}
					/>
				</label>
			</div>
		{/if}
		{#if result && 'createdPath' in result}
			<p role="status" class="break-words text-sm">{m.git_worktree_created_at({ path: result.createdPath })}</p>
		{:else if result && 'error' in result}
			<p role="alert" class="text-sm text-destructive">{result.error}</p>
		{/if}
	</div>
	<div class="flex shrink-0 justify-between gap-3 border-t border-border px-4 py-3">
		<button
			type="button"
			onclick={onBack}
			disabled={isCreating}
			class="rounded-md px-3 py-2 text-sm hover:bg-muted"
		>
			{m.workspace_back()}
		</button>
		<button
			type="submit"
			disabled={!canCreate && !isCreating}
			aria-disabled={!canCreate}
			aria-busy={isCreating}
			class="inline-flex items-center gap-2 rounded-md bg-interactive-accent px-4 py-2 text-sm font-medium text-interactive-accent-foreground aria-disabled:opacity-50"
		>
			{#if isCreating}
				<LoaderCircle class="size-4 animate-spin" />
				{m.common_creating()}
			{:else}
				{m.git_worktree_create_action()}
			{/if}
		</button>
	</div>
</form>
