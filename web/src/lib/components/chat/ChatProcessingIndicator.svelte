<script lang="ts">
	import type { ChatProcessingPhase } from '$shared/chat-types.js';
	import { attachProcessingPulse } from '$lib/chat/sessions/processing-pulse.js';
	import { cn } from '$lib/utils/cn.js';

	let {
		phase,
		label,
		statusId,
		class: className,
		dotClass,
		dotSlot = 'chat-processing-indicator-dot',
	}: {
		phase: ChatProcessingPhase | null;
		label: string;
		statusId?: string;
		class?: string;
		dotClass?: string;
		dotSlot?: string;
	} = $props();
</script>

{#if phase}
	<span id={statusId} class="sr-only">{label}</span>
	<span
		class={cn(
			'chat-processing-indicator size-2 shrink-0 rounded-full bg-status-processing',
			dotClass,
			className,
		)}
		data-phase={phase}
		data-slot={dotSlot}
		aria-hidden="true"
		{@attach attachProcessingPulse}
	></span>
{/if}
