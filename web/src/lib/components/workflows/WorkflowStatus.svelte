<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Circle from '@lucide/svelte/icons/circle';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { workflowNeedsAttention, workflowPhaseLabel, type WorkflowTaskRow } from '$lib/workflows/detail/workflow-projection.js';
  let { phase }: { phase: WorkflowTaskRow['phase'] } = $props();
</script>

<span class="inline-flex min-w-0 items-center gap-1.5 text-xs" class:text-status-success-foreground={phase === 'succeeded'}
  class:text-status-warning-foreground={workflowNeedsAttention(phase)} class:text-muted-foreground={!workflowNeedsAttention(phase) && phase !== 'succeeded'}>
  {#if phase === 'succeeded'}<CircleCheck class="size-3.5 shrink-0" />
  {:else if workflowNeedsAttention(phase)}<CircleAlert class="size-3.5 shrink-0" />
  {:else if ['running', 'checking', 'preparing'].includes(phase)}<LoaderCircle class="size-3.5 shrink-0 animate-spin" />
  {:else}<Circle class="size-3.5 shrink-0" />{/if}
  <span>{workflowPhaseLabel(phase)}</span>
</span>
