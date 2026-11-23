<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import Upload from '@lucide/svelte/icons/upload';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { GitRemoteEntry } from '$lib/api/git.js';

	interface Props {
		open: boolean;
		remotes: GitRemoteEntry[];
		currentBranch: string;
		isPushing: boolean;
		onPush: (remote: string, branch: string) => void;
		onClose: () => void;
	}

	let { open, remotes, currentBranch, isPushing, onPush, onClose }: Props = $props();

	let selectedRemote = $state(
		untrack(() => remotes.find((r) => r.name === 'origin')?.name ?? remotes[0]?.name ?? ''),
	);

	let canPush = $derived(selectedRemote.length > 0 && currentBranch.length > 0 && !isPushing);

	function handlePush(): void {
		if (!canPush) return;
		onPush(selectedRemote, currentBranch);
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canPush) {
			e.preventDefault();
			e.stopPropagation();
			handlePush();
		}
	}
</script>

{#if open}
	<Dialog.Root open={true} requestClose={onClose}>
		<Dialog.Content
			class="flex max-h-[80dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[400px]"
			onkeydowncapture={handleKeydown}
		>
			<Dialog.Header class="shrink-0 border-b border-border px-4 py-3 text-start">
				<Dialog.Title class="pe-8 text-sm font-medium">{m.git_push_title()}</Dialog.Title>
			</Dialog.Header>

			<div class="min-h-0 space-y-3 overflow-y-auto px-4 py-3">
				<div class="space-y-1.5">
					<div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
						{m.git_push_remote()}
					</div>
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
									bind:group={selectedRemote}
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

				<div class="text-xs text-muted-foreground px-1">
					{m.git_push_progress()} <span class="font-medium text-foreground">{currentBranch}</span>
					&rarr;
					<span class="font-medium text-foreground">{selectedRemote}/{currentBranch}</span>
				</div>

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
					{m.git_push_action()}
				</button>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
