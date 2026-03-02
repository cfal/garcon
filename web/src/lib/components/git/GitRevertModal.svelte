<script lang="ts">
	// Confirms whether the latest commit should be reverted or reset softly.

	import * as Dialog from '$lib/components/ui/dialog/index.js';

	type RevertStrategy = 'revert' | 'reset-soft';

	interface GitRevertModalProps {
		strategy: RevertStrategy;
		onStrategyChange: (strategy: RevertStrategy) => void;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { strategy, onStrategyChange, onConfirm, onCancel }: GitRevertModalProps = $props();

	let confirmLabel = $derived(strategy === 'revert' ? 'Revert' : 'Reset');
</script>

<Dialog.Root open={true} onOpenChange={(open) => { if (!open) onCancel(); }}>
	<Dialog.Content showCloseButton={false}>
		<div class="space-y-2">
			<label class="flex items-start gap-2.5 rounded-md border border-border px-3 py-2 cursor-pointer">
				<input
					type="radio"
					name="revert-strategy"
					checked={strategy === 'revert'}
					onchange={() => onStrategyChange('revert')}
					class="mt-0.5 accent-interactive-accent"
				/>
				<div class="space-y-0.5">
					<div class="text-sm font-medium text-foreground">Revert</div>
					<div class="text-xs text-muted-foreground">Creates a new commit that undoes the latest commit.</div>
				</div>
			</label>
			<label class="flex items-start gap-2.5 rounded-md border border-border px-3 py-2 cursor-pointer">
				<input
					type="radio"
					name="revert-strategy"
					checked={strategy === 'reset-soft'}
					onchange={() => onStrategyChange('reset-soft')}
					class="mt-0.5 accent-interactive-accent"
				/>
				<div class="space-y-0.5">
					<div class="text-sm font-medium text-foreground">Reset soft</div>
					<div class="text-xs text-muted-foreground">Removes the latest commit and keeps its changes staged.</div>
				</div>
			</label>
		</div>

		<Dialog.Footer>
			<button
				onclick={onCancel}
				class="px-4 py-2 text-sm text-muted-foreground hover:bg-accent rounded-md"
			>
				Cancel
			</button>
			<button
				onclick={onConfirm}
				class="px-4 py-2 text-sm rounded-md bg-status-warning text-status-warning-foreground hover:brightness-110"
			>
				{confirmLabel}
			</button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
