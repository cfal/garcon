<script module lang="ts">
  import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
  const graphRenderer = lazyRenderer(() => import('./WorkflowGraph.svelte'));
</script>
<script lang="ts">
  import { untrack } from 'svelte';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
  import Square from '@lucide/svelte/icons/square';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Archive from '@lucide/svelte/icons/archive';
  import X from '@lucide/svelte/icons/x';
  import Workflow from '@lucide/svelte/icons/workflow';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import { getAuth, getRemoteSettings, getExecutors, getConversationUi } from '$lib/context';
  import type { WorkflowApprovalManifest, WorkflowDetail, WorkflowEvidenceSummary } from '$shared/workflows';
  import type { WorkflowsController } from '$lib/workflows/catalog/workflows-controller.svelte.js';
  import { workflowRows, workflowNeedsAttention, historicalWorkflowRow } from '$lib/workflows/detail/workflow-projection.js';
  import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
  import WorkflowStatus from './WorkflowStatus.svelte';
  import WorkflowDecision from './WorkflowDecision.svelte';
  import WorkflowTaskInspector from './WorkflowTaskInspector.svelte';
  let { controller, visible, onOpenChat }: { controller: WorkflowsController; visible: boolean; onOpenChat: (id: string) => void } = $props();
  const auth = getAuth();
  const settings = getRemoteSettings();
  const executors = getExecutors();
  const conversationUi = getConversationUi();
  const enabled = $derived(settings.snapshot?.features.workflows.enabled === true);
  const canDecide = $derived(enabled && auth.isAuthenticated && !auth.authDisabled);
  const canRecover = $derived(auth.isAuthenticated && !auth.authDisabled);
  const detail = $derived(controller.detail);
  const rows = $derived(detail ? workflowRows(detail, controller.planView) : []);
  const selected = $derived(controller.selectedTaskId ? rows.find(row => row.task.id === controller.selectedTaskId)
    : controller.inspection ? historicalWorkflowRow(controller.inspection) : undefined);
  const permissions = $derived(new Set(conversationUi.pendingPermissionChatIds));
  const notices = $derived(new Map(rows.map(row => {
    const chatId = row.current?.attempt?.chatId;
    const pending = chatId && permissions.has(chatId);
    const targets = [row.task, ...rows.filter(candidate => row.task.dependsOn.includes(candidate.task.id)).map(candidate => candidate.task)]
      .flatMap(task => 'target' in task.spec ? [task.spec.target.executorId] : []);
    const offline = !['succeeded', 'failed', 'canceled', 'draft'].includes(row.phase)
      && targets.some(id => !executors.isReady(id));
    const cleanup = controller.detail?.operations.find(operation => operation.kind === 'cleanup'
      && ['unknown', 'not-started'].includes(operation.status) && row.current?.attempt?.attemptId === operation.attemptId);
    return [row.task.id, pending ? 'Permission requested in worker chat' : offline ? 'Required executor unavailable'
      : cleanup ? cleanup.detail ?? 'Managed cleanup requires attention' : null];
  })));
  const attention = $derived(rows.filter(row => workflowNeedsAttention(row.phase) || notices.get(row.task.id)));
  const operationAttention = $derived(detail?.operations.filter(operation => !rows.some(row => row.current?.attempt?.attemptId === operation.attemptId)) ?? []);
  const shown = $derived(controller.tab === 'attention' ? attention : rows);
  const busy = $derived(controller.pending || controller.recovery !== null);
  let query = $state('');
  let showArchived = $state(false);
  let decision = $state.raw<{ detail: WorkflowDetail; gate: WorkflowApprovalManifest | null; evidence?: readonly WorkflowEvidenceSummary[] } | null>(null);
  let cancelOpen = $state(false);
  let dismissRecoveryOpen = $state(false);
  $effect(() => {
    const owner = auth.isAuthenticated ? auth.presentationOwner : null;
    untrack(() => controller.setAuthority(owner ? JSON.stringify([owner.mode, owner.key]) : null));
  });
  $effect(() => { const shown = visible; untrack(() => controller.setPresentationVisible(shown)); return () => controller.setPresentationVisible(false); });
  $effect(() => { enabled; untrack(() => controller.invalidate()); });
  const button = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-accent disabled:opacity-40';
  async function openGate(id: string) {
    if (!detail || !canDecide || busy) return;
    const captured = detail;
    const gate = await controller.inspectGate(id);
    if (gate && controller.detail?.workflow.id === captured.workflow.id && canDecide && !busy) decision = { detail: captured, gate: gate.manifest, evidence: gate.evidence };
  }
</script>

<section class="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground" aria-label="Workflows" data-workflow-surface>
  <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
    {#if controller.selectedId}<button class={button} title="Workflow catalog" aria-label="Workflow catalog" onclick={() => controller.select(null)}><ArrowLeft class="size-4" /></button>
    {:else}<Workflow class="size-4" />{/if}
    <h1 class="min-w-0 flex-1 break-words text-sm font-semibold">{detail?.workflow.title ?? 'Workflows'}</h1>
    <button class={button} title="Refresh workflows" aria-label="Refresh workflows" disabled={controller.loading} onclick={() => void controller.refresh()}><RefreshCw class="size-4" /></button>
    <button class={button} disabled={!enabled || busy} onclick={() => controller.newDraft()}><Plus class="size-4" />New draft</button>
  </header>
  {#if controller.error}<div role="alert" class="border-b border-border px-3 py-2 text-sm text-destructive">{controller.error}</div>{/if}
  {#if controller.recovery}<div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-status-warning-foreground">
    <span class="min-w-0 flex-1 break-all">Unconfirmed operation: {controller.recovery.operationId}</span>
    <button class={button} disabled={controller.pending} onclick={() => void controller.recover()}>Recover exact operation</button>
    <button class={button} disabled={controller.pending} onclick={() => { dismissRecoveryOpen = true; }}>Dismiss local recovery</button></div>{/if}
  {#if !enabled}<p class="border-b border-border px-3 py-2 text-xs text-status-warning-foreground">Workflows disabled. New admissions are suspended.</p>{/if}
  {#if controller.dismissedRecoveryId}<p class="break-all border-b border-border px-3 py-2 text-xs text-muted-foreground">Dismissed local recovery: {controller.dismissedRecoveryId}. Server outcome remains unconfirmed.</p>{/if}
  {#if auth.authDisabled}<p class="border-b border-border px-3 py-2 text-xs text-status-warning-foreground">Browser authentication is required for activation and approval.</p>{/if}
  {#if !controller.selectedId}
    <div class="space-y-2 border-b border-border p-3"><input class="h-9 w-full rounded-md border border-border bg-background px-3 text-base sm:text-sm" type="search" aria-label="Search workflows" placeholder="Search workflows" bind:value={query} />
      <label class="flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={showArchived} />Show archived</label></div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#each controller.catalog.filter(workflow => (showArchived || !workflow.archived) && workflow.title.toLowerCase().includes(query.toLowerCase())) as workflow (workflow.id)}
        <button class="flex w-full items-center gap-3 border-b border-border px-4 py-4 text-left hover:bg-accent" onclick={() => controller.select(workflow.id)}>
          <Workflow class="size-4 shrink-0 text-muted-foreground" /><div class="min-w-0 flex-1"><h2 class="break-words text-sm font-medium">{workflow.title}</h2>
            <p class="mt-1 text-xs text-muted-foreground">{workflow.archived ? 'Archived' : workflow.desired} / {workflow.activePlanRevision ? `Active plan ${workflow.activePlanRevision}` : 'Not activated'} / Draft {workflow.draftPlanRevision}</p>
            <p class="mt-1 text-xs text-muted-foreground">{workflow.goal === 'pr-open' ? 'Pull request' : 'Artifacts'} / {workflow.completedTasks} of {workflow.totalTasks} complete</p>
            {#if workflow.attentionTasks || workflow.attentionOperations}<p class="mt-1 text-xs text-status-warning-foreground">Attention: {workflow.attentionTasks} tasks, {workflow.attentionOperations} operations</p>{/if}
            {#if workflow.executorIds.some(id => !executors.isReady(id))}<p class="mt-1 text-xs text-status-warning-foreground">Required executor unavailable</p>{/if}</div>
          <time class="hidden shrink-0 text-xs text-muted-foreground sm:block">{new Date(workflow.updatedAt).toLocaleDateString()}</time>
        </button>
      {:else}<p class="p-8 text-center text-sm text-muted-foreground">{controller.loading ? 'Loading workflows' : query ? 'No matching workflows' : 'No workflows yet'}</p>{/each}
      {#if controller.hasMore}<button class={`${button} m-3`} onclick={() => void controller.loadMore()}>Load more</button>{/if}
    </div>
  {:else if detail}
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <span class="mr-auto text-xs text-muted-foreground">{detail.workflow.archived ? 'Archived' : detail.workflow.desired} / {detail.outcome} / {detail.tasks.filter(task => task.phase === 'succeeded').length} of {detail.tasks.length} complete</span>
      {#if detail.workflow.captainChatId}<button class={button} title="Captain chat" aria-label="Captain chat" onclick={() => onOpenChat(detail.workflow.captainChatId!)}><MessageSquare class="size-4" /></button>{/if}
      <button class={button} title="Edit draft plan" aria-label="Edit draft plan" disabled={!enabled || busy || detail.workflow.archived || detail.workflow.desired === 'canceled'} onclick={() => controller.editDraft()}><Pencil class="size-4" /></button>
      {#if !detail.workflow.archived && (detail.workflow.desired === 'draft' || detail.workflow.draftPlanRevision !== detail.workflow.activePlanRevision)}
        <button class={button} disabled={!canDecide || busy || detail.workflow.desired === 'canceled'} onclick={() => { decision = { detail, gate: null }; }}><Play class="size-3.5" />Review activation</button>
      {:else if !detail.workflow.archived && detail.workflow.desired === 'paused'}
        <button class={button} disabled={!canDecide || busy} onclick={() => void controller.mutate({ action: 'resume', workflowId: detail.workflow.id,
          controlEpoch: detail.workflow.controlEpoch, planRevision: detail.workflow.activePlanRevision! })}><Play class="size-3.5" />Resume</button>
      {:else if detail.workflow.desired === 'active'}
        <button class={button} disabled={busy} onclick={() => void controller.mutate({ action: 'pause', workflowId: detail.workflow.id })}><Pause class="size-3.5" />Pause</button>
      {/if}
      {#if !detail.workflow.archived && detail.workflow.desired !== 'canceled'}
        <button class={button} disabled={busy} onclick={() => void controller.mutate({ action: 'stop', workflowId: detail.workflow.id })}><Square class="size-3" />Stop</button>
        <button class={button} title="Cancel workflow" aria-label="Cancel workflow" disabled={!canRecover || busy} onclick={() => { cancelOpen = true; }}><X class="size-4" /></button>
      {/if}
      {#if !detail.workflow.archived && detail.workflow.desired !== 'active'}<button class={button} title="Archive workflow" aria-label="Archive workflow" disabled={!canRecover || busy} onclick={() => void controller.mutate({ action: 'archive', workflowId: detail.workflow.id })}><Archive class="size-4" /></button>{/if}
    </div>
    <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3">
      <div class="flex flex-wrap items-center gap-1" role="tablist" aria-label="Workflow views">
        {#each ['list', 'graph', 'attention', 'history', 'activity'] as tab (tab)}
          <button role="tab" aria-selected={controller.tab === tab} class="border-b-2 px-3 py-3 text-xs capitalize"
            class:border-primary={controller.tab === tab} class:border-transparent={controller.tab !== tab}
            onclick={() => { controller.tab = tab as typeof controller.tab; }}>{tab}{tab === 'attention' && attention.length + operationAttention.length ? ` (${attention.length + operationAttention.length})` : ''}</button>
        {/each}
      </div>
      <select class="ml-auto rounded border border-border bg-background p-1.5 text-base sm:text-xs" aria-label="Plan revision" bind:value={controller.planView}>
        <option value="active" disabled={!detail.active}>Active {detail.active?.revision ?? ''}</option><option value="draft">Draft {detail.draft.revision}</option>
      </select>
    </div>
    <div class="workflow-body grid min-h-0 min-w-0 flex-1" class:with-inspector={!!selected}>
      <div class="min-h-0 min-w-0 overflow-auto" class:inspector-covered={!!selected}>
        {#if controller.tab === 'graph'}
          {#await graphRenderer() then WorkflowGraph}<WorkflowGraph {rows} selectedId={controller.selectedTaskId} onselect={(id) => controller.selectTask(id)} />{/await}
        {:else if controller.tab === 'history'}
          {#each controller.attempts as attempt (attempt.attemptId)}
            <button class="block w-full space-y-1 border-b border-border p-3 text-left text-xs hover:bg-accent" onclick={() => void controller.inspectAttempt(attempt.attemptId)}>
              <p class="break-words font-medium">{attempt.taskId} / {attempt.resolution}</p>
              <p class="text-muted-foreground">Plan {attempt.planRevision} / Generation {attempt.generation}</p>
              <p class="break-all text-muted-foreground">{attempt.attemptId}</p>
              <time class="text-muted-foreground">{new Date(attempt.createdAt).toLocaleString()}</time>
            </button>
          {:else}<p class="p-6 text-sm text-muted-foreground">No attempts</p>{/each}
          {#if controller.hasMoreAttempts}<button class={`${button} m-3`} disabled={controller.loadingHistory} onclick={() => void controller.loadHistory('attempts')}>Older attempts</button>{/if}
        {:else if controller.tab === 'activity'}
          {#each controller.activity as event (event.sequence)}<div class="space-y-1 border-b border-border p-3 text-xs"><p class="font-medium">{event.action}</p>
            <p class="break-all text-muted-foreground">{event.detail}</p><p class="text-muted-foreground">{event.actor} / {new Date(event.at).toLocaleString()}</p></div>
          {:else}<p class="p-6 text-sm text-muted-foreground">No activity</p>{/each}
          {#if controller.hasMoreActivity}<button class="m-3 rounded border border-border px-3 py-2 text-sm" disabled={controller.loadingHistory}
            onclick={() => void controller.loadHistory('activity')}>Older activity</button>{/if}
        {:else}
          {#if controller.tab === 'attention'}
            {#each operationAttention as operation (operation.id)}
              <button class="block w-full space-y-1 border-b border-border p-3 text-left text-xs hover:bg-accent" onclick={() => void controller.inspectAttempt(operation.attemptId)}>
                <p class="font-medium">Historical {operation.kind} / {operation.status}</p>
                <p class="break-words text-status-warning-foreground">{operation.detail ?? 'Retained operation requires attention'}</p>
                <p class="break-all text-muted-foreground">{operation.id}</p>
              </button>
            {/each}
          {/if}
          {#each shown as row (row.task.id)}
            <div class="flex items-center gap-2 border-b border-border pr-3" class:bg-accent={controller.selectedTaskId === row.task.id}>
              <button class="flex min-w-0 flex-1 items-start gap-3 px-3 py-4 text-left hover:bg-muted" onclick={() => controller.selectTask(row.task.id)}>
                <div class="min-w-0 flex-1"><p class="break-words text-sm font-medium">{row.task.title}</p>
                  <p class="mt-1 break-words text-xs text-muted-foreground">{row.task.spec.kind}{'target' in row.task.spec ? ` / ${row.task.spec.target.executorId}` : ''}</p>
                  {#if row.current?.blockedReason}<p class="mt-1 break-words text-xs text-muted-foreground">{row.current.blockedReason}</p>{/if}
                  {#if notices.get(row.task.id)}<p class="mt-1 break-words text-xs text-status-warning-foreground">{notices.get(row.task.id)}</p>{/if}
                </div><WorkflowStatus phase={row.phase} />
              </button>
              {#if row.phase === 'awaiting-approval'}<button class={button} disabled={!canDecide || busy || !detail.gates.some(gate => gate.manifest.gateId === row.task.id)} onclick={() => openGate(row.task.id)}>Review</button>{/if}
              {#if row.current?.attempt?.chatId && permissions.has(row.current.attempt.chatId)}<button class={button}
                onclick={() => onOpenChat(row.current!.attempt!.chatId!)}>Open worker</button>{/if}
            </div>
          {:else}{#if controller.tab !== 'attention' || !operationAttention.length}<p class="p-6 text-sm text-muted-foreground">{controller.tab === 'attention' ? 'No tasks need attention' : 'No tasks'}</p>{/if}{/each}
        {/if}
      </div>
      {#if selected}
        {#key `${selected.task.id}:${selected.current?.generation ?? controller.inspection?.attempt.generation ?? ''}:${selected.current?.attempt?.attemptId ?? controller.inspection?.attempt.attemptId ?? ''}`}
          <WorkflowTaskInspector row={selected} history={controller.inspection} {controller} {canDecide} {canRecover} {onOpenChat} onclose={() => controller.selectTask(null)} />
        {/key}
      {/if}
    </div>
  {:else}<p class="p-6 text-sm text-muted-foreground">{controller.loading ? 'Loading workflow' : 'Workflow unavailable'}</p>{/if}
</section>

{#if decision}<WorkflowDecision detail={decision.detail} gate={decision.gate} evidence={decision.evidence} pending={controller.pending}
  onclose={() => { decision = null; }} onsubmit={(mutation) => controller.mutate(mutation)} />{/if}
<Dialog open={controller.editor !== null} onOpenChange={(open) => { if (!open && !controller.pending) controller.editor = null; }}>
  <DialogContent class="sm:max-w-3xl"><DialogTitle>{controller.editorWorkflowId ? 'Edit draft plan' : 'New workflow draft'}</DialogTitle>
    <DialogDescription>Plan JSON</DialogDescription>
    <form onsubmit={(event) => { event.preventDefault(); void controller.saveDraft(); }} class="space-y-3">
      <textarea class="h-[55dvh] w-full rounded-md border border-border bg-background p-3 font-mono text-base sm:text-sm" aria-label="Workflow plan JSON" spellcheck={false}
        value={controller.editor ?? ''} oninput={(event) => { controller.editor = event.currentTarget.value; }}></textarea>
      {#if controller.error}<p role="alert" class="text-sm text-destructive">{controller.error}</p>{/if}
      <DialogFooter><button class={button} type="button" disabled={controller.pending} onclick={() => { controller.editor = null; }}>Cancel</button>
        <button class={button} disabled={!enabled || busy}>Save draft</button></DialogFooter>
    </form>
  </DialogContent>
</Dialog>
<Dialog bind:open={dismissRecoveryOpen}><DialogContent><DialogTitle>Dismiss local recovery?</DialogTitle>
  <DialogDescription>The server operation may have completed. This only archives its identity in this browser tab; it does not cancel or repeat it. Inspect the workflow before submitting another decision.</DialogDescription>
  <DialogFooter><button class={button} disabled={controller.pending} onclick={() => { controller.dismissRecovery(); dismissRecoveryOpen = false; }}>Dismiss local recovery</button></DialogFooter>
</DialogContent></Dialog>
<Dialog bind:open={cancelOpen}><DialogContent><DialogTitle>Cancel workflow?</DialogTitle><DialogDescription>Running work will be stopped where possible. Uncertain resources remain retained. Cancellation cannot be undone.</DialogDescription>
  <DialogFooter><button class={button} disabled={busy || !canRecover} onclick={async () => { if (detail && await controller.mutate({ action: 'cancel', workflowId: detail.workflow.id })) cancelOpen = false; }}>Cancel workflow</button></DialogFooter>
</DialogContent></Dialog>

<style>
  .with-inspector { grid-template-columns: minmax(0, 1fr) 320px; }
  @media (max-width: 760px) {
    .with-inspector { grid-template-columns: minmax(0, 1fr); }
    .inspector-covered { display: none; }
  }
</style>
