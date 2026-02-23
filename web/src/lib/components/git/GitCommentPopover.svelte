<script lang="ts">
	// Anchored popover for composing an inline review comment.
	// Used on desktop near the diff line where the user clicked.

	import X from '@lucide/svelte/icons/x';

	interface ComposerState {
		open: boolean;
		filePath: string;
		side: 'before' | 'after';
		line: number;
		body: string;
		severity: 'note' | 'warning' | 'blocker';
	}

	interface Props {
		composer: ComposerState;
		onBodyChange: (body: string) => void;
		onSeverityChange: (severity: 'note' | 'warning' | 'blocker') => void;
		onSubmit: () => void;
		onClose: () => void;
	}

	let { composer, onBodyChange, onSeverityChange, onSubmit, onClose }: Props = $props();

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			if (composer.body.trim()) onSubmit();
		}
		if (e.key === 'Escape') onClose();
	}
</script>

<div class="border border-border rounded-lg shadow-lg bg-background w-80 overflow-hidden">
	<!-- Header -->
	<div class="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20">
		<span class="text-[11px] text-muted-foreground truncate flex-1">
			{composer.filePath}:{composer.line} ({composer.side})
		</span>
		<button
			onclick={onClose}
			class="p-0.5 rounded hover:bg-muted transition-colors shrink-0 ml-2"
		>
			<X class="w-3.5 h-3.5 text-muted-foreground" />
		</button>
	</div>

	<div class="p-3 space-y-2">
		<!-- Severity radio group -->
		<div class="flex gap-2">
			{#each (['note', 'warning', 'blocker'] as const) as sev}
				<label class="flex items-center gap-1 text-[11px] cursor-pointer">
					<input
						type="radio"
						checked={composer.severity === sev}
						onchange={() => onSeverityChange(sev)}
						class="accent-interactive-accent"
					/>
					{sev}
				</label>
			{/each}
		</div>

		<!-- Comment body -->
		<textarea
			value={composer.body}
			oninput={(e) => onBodyChange(e.currentTarget.value)}
			onkeydown={handleKeydown}
			placeholder="Comment..."
			class="w-full text-xs p-2 bg-background border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			rows="3"
		></textarea>

		<!-- Actions -->
		<div class="flex gap-1.5 justify-end">
			<button
				onclick={onClose}
				class="px-2.5 py-1 text-[11px] rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
			>
				Cancel
			</button>
			<button
				onclick={onSubmit}
				disabled={!composer.body.trim()}
				class="px-2.5 py-1 text-[11px] rounded transition-all
					{composer.body.trim()
						? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
						: 'bg-muted text-muted-foreground cursor-not-allowed'}"
			>
				Add comment
			</button>
		</div>
	</div>
</div>
