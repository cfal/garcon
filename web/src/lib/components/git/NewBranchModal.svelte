<script lang="ts">
	// Dialog for creating a new git branch from the current branch.

	import * as m from '$lib/paraglide/messages.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import Plus from '@lucide/svelte/icons/plus';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	interface NewBranchModalProps {
		currentBranch: string;
		newBranchName: string;
		isCreatingBranch: boolean;
		onNameChange: (name: string) => void;
		onCreateBranch: () => void;
		onClose: () => void;
	}

	let {
		currentBranch,
		newBranchName,
		isCreatingBranch,
		onNameChange,
		onCreateBranch,
		onClose
	}: NewBranchModalProps = $props();

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !isCreatingBranch && newBranchName.trim()) {
			onCreateBranch();
		}
	}
</script>

<Dialog.Root open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{m.git_new_branch_title()}</Dialog.Title>
			<Dialog.Description>
				{m.git_new_branch_description({ branch: currentBranch })}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			<div>
				<label for="branch-name" class="block text-sm font-medium mb-2">{m.git_new_branch_branch_name()}</label>
				<input
					id="branch-name"
					type="text"
					value={newBranchName}
					oninput={(e) => onNameChange((e.target as HTMLInputElement).value)}
					onkeydown={handleKeydown}
					placeholder={m.git_new_branch_placeholder()}
					class="w-full px-3 py-2 border border-border rounded-md bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				/>
			</div>
		</div>

		<Dialog.Footer>
			<button
				onclick={() => { onClose(); onNameChange(''); }}
				class="px-4 py-2 text-sm text-muted-foreground hover:bg-accent rounded-md"
			>{m.git_new_branch_cancel()}</button>
			<button
				onclick={onCreateBranch}
				disabled={!newBranchName.trim() || isCreatingBranch}
				class="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
			>
				{#if isCreatingBranch}
					<LoaderCircle class="w-3 h-3 animate-spin" />
					<span>{m.git_new_branch_creating()}</span>
				{:else}
					<Plus class="w-3 h-3" />
					<span>{m.git_new_branch_create()}</span>
				{/if}
			</button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
