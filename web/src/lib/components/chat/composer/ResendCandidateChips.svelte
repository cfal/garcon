<script lang="ts">
	import type { ResendCandidate } from '$shared/chat-view';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		candidates: readonly ResendCandidate[];
		onExclude: (ordinal: number) => void;
	}

	let { candidates, onExclude }: Props = $props();

	function label(candidate: ResendCandidate): string {
		const content = candidate.content.trim();
		if (content) return content;
		return candidate.attachmentNames.join(', ');
	}
</script>

{#if candidates.length > 0}
	<div class="border-b border-border px-4 py-2.5" data-resend-candidates>
		<p class="mb-2 text-xs font-medium text-muted-foreground">
			{m.chat_composer_resend_candidates()}
		</p>
		<div class="flex flex-wrap gap-1.5">
			{#each candidates as candidate (candidate.ordinal)}
				{@const content = label(candidate)}
				<div class="flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 py-1 pl-2.5 pr-1 text-xs text-foreground">
					<span class="max-w-64 truncate">{content}</span>
					<button
						type="button"
						class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						aria-label={m.chat_composer_skip_resend({ content })}
						title={m.chat_composer_skip_resend({ content })}
						onclick={() => onExclude(candidate.ordinal)}
					>
						<X class="h-3.5 w-3.5" aria-hidden="true" />
					</button>
				</div>
			{/each}
		</div>
	</div>
{/if}
