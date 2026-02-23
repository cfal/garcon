<script lang="ts">
	// Generic confirmation dialog for destructive git operations (discard,
	// commit, push, pull, delete). Shows a warning icon and provides
	// contextual button styling based on the action type.

	import * as m from '$lib/paraglide/messages.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import type { ConfirmAction } from '$lib/api/git';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import Check from '@lucide/svelte/icons/check';
	import Download from '@lucide/svelte/icons/download';
	import Upload from '@lucide/svelte/icons/upload';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	interface GitConfirmModalProps {
		confirmAction: ConfirmAction;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { confirmAction, onConfirm, onCancel }: GitConfirmModalProps = $props();

	const titleByAction: Record<string, () => string> = {
		discard: m.git_confirm_discard_changes,
		delete: m.git_confirm_delete_file,
		commit: m.git_confirm_confirm_commit,
		pull: m.git_confirm_confirm_pull,
		push: m.git_confirm_confirm_push,
	};

	const buttonClasses: Record<string, string> = {
		discard: 'bg-destructive hover:bg-destructive/90',
		delete: 'bg-destructive hover:bg-destructive/90',
		commit: 'bg-git-action-commit hover:bg-git-action-commit-hover',
		pull: 'bg-git-action-pull hover:bg-git-action-pull-hover',
		push: 'bg-git-action-push hover:bg-git-action-push-hover',
	};

	const buttonLabelByAction: Record<string, () => string> = {
		discard: m.git_confirm_discard,
		delete: m.git_confirm_delete,
		commit: m.git_confirm_commit,
		pull: m.git_confirm_pull,
		push: m.git_confirm_push,
	};

	let isDestructive = $derived(confirmAction.type === 'discard' || confirmAction.type === 'delete');
</script>

<Dialog.Root open={true} onOpenChange={(open) => { if (!open) onCancel(); }}>
	<Dialog.Content showCloseButton={false}>
		<Dialog.Header>
			<div class="flex items-center">
				<div class="p-2 rounded-full mr-3 {isDestructive ? 'bg-status-error' : 'bg-diff-modified'}">
					<AlertTriangle class="w-5 h-5 {isDestructive ? 'text-status-error-foreground' : 'text-diff-modified-foreground'}" />
				</div>
				<Dialog.Title>{titleByAction[confirmAction.type]()}</Dialog.Title>
			</div>
		</Dialog.Header>

		<p class="text-sm text-muted-foreground">{confirmAction.message}</p>

		<Dialog.Footer>
			<button
				onclick={onCancel}
				class="px-4 py-2 text-sm text-muted-foreground hover:bg-accent rounded-md"
			>{m.git_confirm_cancel()}</button>
			<button
				onclick={onConfirm}
				class="px-4 py-2 text-sm rounded-md flex items-center space-x-2 {isDestructive ? 'text-destructive-foreground' : 'text-git-action-foreground'} {buttonClasses[confirmAction.type]}"
			>
				{#if confirmAction.type === 'discard' || confirmAction.type === 'delete'}
					<Trash2 class="w-4 h-4" />
				{:else if confirmAction.type === 'commit'}
					<Check class="w-4 h-4" />
				{:else if confirmAction.type === 'pull'}
					<Download class="w-4 h-4" />
				{:else}
					<Upload class="w-4 h-4" />
				{/if}
				<span>{buttonLabelByAction[confirmAction.type]()}</span>
			</button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
