<script lang="ts">
	import type { Snippet } from 'svelte';
	import { attachProcessingPulse } from '$lib/chat/sessions/processing-pulse.js';
	import { cn } from '$lib/utils/cn';

	interface Props {
		tone?: 'idle' | 'processing';
		placement?: 'composer-cap' | 'standalone';
		announcementsEnabled?: boolean;
		busy?: boolean;
		children: Snippet;
	}

	let { tone = 'idle', placement = 'composer-cap', announcementsEnabled = true, busy = false, children }: Props = $props();
</script>

<!-- The composer overlaps the out-of-flow frame; notice/queue/feed owns its reserved space. -->
<div class={placement === 'composer-cap' ? 'absolute bottom-full left-0 right-0 z-10 translate-y-3' : 'relative'}>
	<div
		class={cn(
			'pointer-events-auto flex items-center justify-between gap-3 border border-border px-3 sm:px-4',
			placement === 'composer-cap' ? 'min-h-14 rounded-t-2xl border-b-0 pb-5 pt-2' : 'min-h-10 rounded-md py-2',
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
