<script lang="ts">
	// Push dialog that lets the user choose a remote, optionally
	// override the remote branch name, and confirm the push. Replaces
	// the old generic confirm dialog and the separate publish flow.

	import { untrack } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import Upload from '@lucide/svelte/icons/upload';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { GitRemoteEntry } from '$lib/api/git.js';

	interface Props {
		remotes: GitRemoteEntry[];
		currentBranch: string;
		isPushing: boolean;
		onPush: (remote: string, remoteBranch?: string) => void;
		onClose: () => void;
	}

	let { remotes, currentBranch, isPushing, onPush, onClose }: Props = $props();

	let selectedRemote = $state(untrack(() =>
		remotes.find((r) => r.name === 'origin')?.name ?? remotes[0]?.name ?? '',
	));
	let overrideBranch = $state(false);
	let remoteBranchName = $state(untrack(() => currentBranch));

	let canPush = $derived(selectedRemote.length > 0 && !isPushing);

	function handlePush(): void {
		if (!canPush) return;
		onPush(selectedRemote, overrideBranch ? remoteBranchName : undefined);
	}

	function handleBackdropClick(e: MouseEvent): void {
		if (e.target === e.currentTarget) onClose();
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') onClose();
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canPush) {
			e.preventDefault();
			handlePush();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
	onclick={handleBackdropClick}
	onkeydown={handleKeydown}
>
	<div class="bg-background border border-border rounded-lg shadow-xl w-[400px] max-h-[80vh] flex flex-col">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
			<h2 class="text-sm font-medium text-foreground">Push to remote</h2>
			<button
				onclick={onClose}
				class="p-1 rounded hover:bg-muted transition-colors text-muted-foreground"
			>
				<X class="w-4 h-4" />
			</button>
		</div>

		<!-- Remote list -->
		<div class="px-4 py-3 space-y-3 shrink-0">
			<div class="space-y-1.5">
				<div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Remote</div>
				<div class="space-y-1">
					{#each remotes as remote (remote.name)}
						<label
							class="flex items-center gap-2.5 px-3 py-2 rounded-md border transition-colors cursor-pointer
								{selectedRemote === remote.name
									? 'border-interactive-accent bg-interactive-accent/5'
									: 'border-border hover:bg-muted/50'}"
						>
							<input
								type="radio"
								name="remote"
								value={remote.name}
								checked={selectedRemote === remote.name}
								onchange={() => { selectedRemote = remote.name; }}
								class="accent-interactive-accent"
							/>
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium text-foreground">{remote.name}</div>
								<div class="text-[10px] text-muted-foreground truncate">{remote.url}</div>
							</div>
						</label>
					{/each}
				</div>
			</div>

			<!-- Branch override -->
			<div class="space-y-1.5">
				<label class="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={overrideBranch}
						onchange={() => { overrideBranch = !overrideBranch; }}
						class="accent-interactive-accent"
					/>
					<span class="text-xs text-muted-foreground">Override remote branch name</span>
				</label>
				{#if overrideBranch}
					<input
						type="text"
						value={remoteBranchName}
						oninput={(e) => { remoteBranchName = e.currentTarget.value; }}
						placeholder={currentBranch}
						class="w-full text-sm px-2.5 py-1.5 bg-muted/30 border border-border rounded-md
							focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					/>
				{:else}
					<div class="text-xs text-muted-foreground px-1">
						Pushing <span class="font-medium text-foreground">{currentBranch}</span>
						{' '}&rarr;{' '}
						<span class="font-medium text-foreground">{selectedRemote}/{currentBranch}</span>
					</div>
				{/if}
			</div>

			<!-- Action -->
			<button
				onclick={handlePush}
				disabled={!canPush}
				class="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200
					{canPush
						? 'bg-git-action-push text-git-action-foreground hover:bg-git-action-push-hover'
						: 'bg-muted text-muted-foreground cursor-not-allowed'}"
			>
				{#if isPushing}
					<LoaderCircle class="w-4 h-4 animate-spin" />
				{:else}
					<Upload class="w-4 h-4" />
				{/if}
				Push
			</button>
		</div>
	</div>
</div>
