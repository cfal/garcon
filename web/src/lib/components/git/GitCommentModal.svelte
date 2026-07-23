<script lang="ts">
	// Full-screen modal for composing an inline review comment on mobile.

	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
	import { gitCommentSeverityLabel } from './git-comment-labels';
	import { getTransientLayers } from '$lib/context';
	import { transientLayer } from '$lib/workspace/transient-layer-action.js';

	import type { CommentComposerState } from '$lib/git/review/git-review-drafts.svelte.js';

	interface Props {
		composer: CommentComposerState;
		onBodyChange: (body: string) => void;
		onSeverityChange: (severity: 'note' | 'warning' | 'blocker') => void;
		onSubmit: () => void;
		onClose: () => void;
		onFocusHandled: () => void;
	}

	let { composer, onBodyChange, onSeverityChange, onSubmit, onClose, onFocusHandled }: Props =
		$props();
	const transientLayers = getTransientLayers();
	const focusReturnTarget =
		typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	let textareaElement = $state<HTMLTextAreaElement | null>(null);

	$effect(() => {
		if (!textareaElement || !composer.focusPending) return;
		textareaElement.focus();
		onFocusHandled();
	});

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}

	function handleLayerEscape(): boolean {
		onClose();
		return true;
	}
</script>

<div
	class="fixed inset-0 z-50 flex flex-col bg-background"
	role="dialog"
	tabindex="-1"
	aria-modal="true"
	aria-label={m.git_comment_add()}
	onkeydown={handleKeydown}
	use:transientLayer={{
		registry: transientLayers,
		id: 'git-comment-dialog',
		kind: 'application-dialog',
		modality: 'main-inert',
		onEscape: handleLayerEscape,
		restoreFocus: () => focusReturnTarget?.focus(),
	}}
>
	<!-- Header -->
	<div class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
		<h2 class="text-sm font-medium text-foreground">{m.git_comment_add()}</h2>
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
			{#each ['note', 'warning', 'blocker'] as const as sev}
				<label class="flex items-center gap-1.5 text-xs cursor-pointer">
					<input
						type="radio"
						checked={composer.severity === sev}
						onchange={() => onSeverityChange(sev)}
						class="accent-interactive-accent"
					/>
					{gitCommentSeverityLabel(sev)}
				</label>
			{/each}
		</div>

		<!-- Body -->
		<textarea
			bind:this={textareaElement}
			value={composer.body}
			oninput={(e) => onBodyChange(e.currentTarget.value)}
			placeholder={m.git_comment_placeholder()}
			class="w-full p-3 text-base sm:pointer-fine:text-sm bg-background border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			rows="6"></textarea>
	</div>

	<!-- Sticky actions -->
	<div class="flex gap-2 px-4 py-3 border-t border-border shrink-0">
		<button
			onclick={onClose}
			class="flex-1 px-3 py-2 text-xs rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
		>
			{m.git_confirm_cancel()}
		</button>
		<button
			onclick={onSubmit}
			disabled={!composer.body.trim()}
			class="flex-1 px-3 py-2 text-xs rounded transition-all
				{composer.body.trim()
				? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
				: 'bg-muted text-muted-foreground cursor-not-allowed'}"
		>
			{m.git_comment_add()}
		</button>
	</div>
</div>
