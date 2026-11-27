<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Clock3 from '@lucide/svelte/icons/clock-3';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { WorkflowGraphNodeTone } from '$lib/workflows/definition/workflow-graph';

	let { tone }: { tone: WorkflowGraphNodeTone } = $props();
</script>

{#if tone === 'success'}
	<CircleCheck class="size-3.5 shrink-0 text-status-success-foreground" aria-hidden="true" />
{:else if tone === 'error'}
	<CircleAlert class="size-3.5 shrink-0 text-status-error-foreground" aria-hidden="true" />
{:else if tone === 'warning'}
	<Clock3 class="size-3.5 shrink-0 text-status-warning-foreground" aria-hidden="true" />
{:else if tone === 'info'}
	<LoaderCircle class="size-3.5 shrink-0 text-status-info-foreground" aria-hidden="true" />
{:else}
	<span
		class="size-2 shrink-0 rounded-full bg-status-neutral-foreground/50"
		aria-hidden="true"
	></span>
{/if}
