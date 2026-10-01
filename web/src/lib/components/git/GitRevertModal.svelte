<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import * as Dialog from '$lib/components/ui/dialog/index.js';

	interface GitRevertModalProps {
		commitShortHash: string;
		commitSubject: string;
		isReverting: boolean;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { commitShortHash, commitSubject, isReverting, onConfirm, onCancel }: GitRevertModalProps =
		$props();
</script>

<Dialog.Root
	open={true}
	onOpenChange={(open) => {
		if (!open && !isReverting) onCancel();
	}}
>
	<Dialog.Content showCloseButton={false}>
		<div class="space-y-2">
			<div class="text-sm font-medium text-foreground">{m.git_revert_title()}</div>
			<div class="text-sm text-muted-foreground">
				{m.git_revert_description_prefix()}
				<span class="font-mono text-foreground">{commitShortHash}</span>.
			</div>
			<div class="rounded border border-border bg-muted/30 px-3 py-2 text-xs text-foreground">
				{commitSubject || commitShortHash}
			</div>
		</div>

		<Dialog.Footer>
			<button
				type="button"
				onclick={onCancel}
				disabled={isReverting}
				class="rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
			>
				{m.common_cancel()}
			</button>
			<button
				type="button"
				onclick={onConfirm}
				disabled={isReverting}
				class="inline-flex items-center gap-2 rounded-md bg-status-warning px-4 py-2 text-sm text-status-warning-foreground hover:brightness-110 disabled:opacity-50"
			>
				{#if isReverting}
					<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
				{/if}
				{m.git_revert_action()}
			</button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
