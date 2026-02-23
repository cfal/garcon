<script lang="ts">
	// Full-screen modal for composing an inline review comment on mobile.

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
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 z-50 flex flex-col bg-background">
	<!-- Header -->
	<div class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
		<h2 class="text-sm font-medium text-foreground">Add comment</h2>
		<button onclick={onClose} class="p-1 rounded hover:bg-muted transition-colors">
			<X class="w-4 h-4 text-muted-foreground" />
		</button>
	</div>

	<div class="flex-1 overflow-y-auto p-4 space-y-3">
		<!-- File context -->
		<div class="text-[11px] text-muted-foreground font-mono truncate">
			{composer.filePath}:{composer.line} ({composer.side})
		</div>

		<!-- Severity -->
		<div class="flex gap-3">
			{#each (['note', 'warning', 'blocker'] as const) as sev}
				<label class="flex items-center gap-1.5 text-xs cursor-pointer">
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

		<!-- Body -->
		<textarea
			value={composer.body}
			oninput={(e) => onBodyChange(e.currentTarget.value)}
			placeholder="Comment..."
			class="w-full text-sm p-3 bg-background border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			rows="6"
		></textarea>
	</div>

	<!-- Sticky actions -->
	<div class="flex gap-2 px-4 py-3 border-t border-border shrink-0">
		<button
			onclick={onClose}
			class="flex-1 px-3 py-2 text-xs rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
		>
			Cancel
		</button>
		<button
			onclick={onSubmit}
			disabled={!composer.body.trim()}
			class="flex-1 px-3 py-2 text-xs rounded transition-all
				{composer.body.trim()
					? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
					: 'bg-muted text-muted-foreground cursor-not-allowed'}"
		>
			Add comment
		</button>
	</div>
</div>
