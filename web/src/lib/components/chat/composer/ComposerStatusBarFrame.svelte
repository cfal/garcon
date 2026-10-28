<script lang="ts">
	import type { Snippet } from 'svelte';
	import { attachProcessingPulse } from '$lib/chat/sessions/processing-pulse.js';
	import { cn } from '$lib/utils/cn';

	interface Props {
		tone?: 'idle' | 'processing';
		announcementsEnabled?: boolean;
		busy?: boolean;
		children: Snippet;
	}

	let { tone = 'idle', announcementsEnabled = true, busy = false, children }: Props = $props();
</script>

<!-- The composer overlaps the out-of-flow frame; notice/queue/feed owns its reserved space. -->
<div class="absolute bottom-full left-0 right-0 z-10 translate-y-3">
	<div
		class={cn(
			'pointer-events-auto flex min-h-14 items-center justify-between gap-3 rounded-t-2xl border border-b-0 border-border px-3 pb-5 pt-2 sm:px-4',
			tone === 'processing' ? 'bg-chat-thinking' : 'bg-card',
		)}
		role={announcementsEnabled ? 'status' : undefined}
		aria-live={announcementsEnabled ? 'polite' : 'off'}
		aria-busy={busy}
		data-composer-status-bar={tone}
		data-slot={tone === 'processing' ? 'chat-processing-status' : 'chat-git-status'}
		{@attach tone === 'processing' ? attachProcessingPulse : undefined}
	>
		{@render children()}
	</div>
</div>
