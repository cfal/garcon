<script lang="ts">
	import { scheduledRunOutcomeTone } from '$lib/scheduling/schedule-labels';
	import type { ScheduledPromptRunOutcome } from '$shared/scheduled-prompts';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleMinus from '@lucide/svelte/icons/circle-minus';
	import { cn } from '$lib/utils/cn.js';

	interface Props {
		outcome: ScheduledPromptRunOutcome;
		class?: string;
	}

	let { outcome, class: className }: Props = $props();
	const tone = $derived(scheduledRunOutcomeTone(outcome));
</script>

{#if tone === 'success'}
	<CircleCheck
		class={cn('shrink-0 text-status-success-foreground', className)}
		aria-hidden="true"
	/>
{:else if tone === 'warning'}
	<CircleMinus
		class={cn('shrink-0 text-status-warning-foreground', className)}
		aria-hidden="true"
	/>
{:else}
	<CircleAlert class={cn('shrink-0 text-status-error-foreground', className)} aria-hidden="true" />
{/if}
