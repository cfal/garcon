<script module lang="ts">
  import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
  const diffRenderer = lazyRenderer(() => import('./WorkflowDiff.svelte'));
</script>
<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import GitCompareArrows from '@lucide/svelte/icons/git-compare-arrows';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import type { WorkflowArtifact, WorkflowAttempt, WorkflowAttemptInspection } from '$shared/workflows';
  import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
  import type { WorkflowTaskRow } from '$lib/workflows/detail/workflow-projection.js';
  import type { WorkflowsController } from '$lib/workflows/catalog/workflows-controller.svelte.js';
  import WorkflowStatus from './WorkflowStatus.svelte';
  let { row, history = null, controller, canDecide, canRecover, onOpenChat, onclose }: { row: WorkflowTaskRow; history?: WorkflowAttemptInspection | null; controller: WorkflowsController; canDecide: boolean; canRecover: boolean;
    onOpenChat: (id: string) => void; onclose: () => void } = $props();
  const artifacts = $derived(history?.artifacts ?? controller.detail?.artifacts.filter(artifact => artifact.attempt.taskId === row.task.id) ?? []);
  const attempts = $derived(history ? [history.attempt] : controller.attempts.filter(attempt => attempt.taskId === row.task.id));
  const operations = $derived(history?.operations ?? controller.detail?.operations.filter(operation => attempts.some(attempt => attempt.attemptId === operation.attemptId)) ?? []);
  const resources = $derived(history?.resources ?? controller.detail?.resources ?? []);
  const resolutionAttempt = $derived(row.current?.attempt ?? history?.attempt);
  const matchingInspection = $derived(!history || !row.current || history.attempt.attemptId === row.current.attempt?.attemptId);
  const canAdopt = $derived(row.current !== null && (row.task.spec.kind === 'agent' || row.task.spec.kind === 'publish-pr'));
  const canClearHold = $derived(row.current?.hold !== 'none' && (!row.current?.attempt
    || row.current.attempt.resolution === 'not-started' && row.current.attempt.controlState !== 'leased'));
  let evidence = $state('');
  let releaseRisk = $state(false);
  let resolution = $state<'abandon' | 'not-started' | 'adopt'>('abandon');
  let commit = $state('');
  let diff = $state<WorkflowArtifact | null>(null);
  let cleanup = $state<WorkflowAttempt | null>(null);
  let cleanupHead = $state('');
  let cleanupConfirmed = $state(false);
  const busy = $derived(controller.pending || controller.recovery !== null);
  async function resolve() {
    const attempt = resolutionAttempt;
    if (!attempt || !matchingInspection || row.phase !== 'outcome-unknown' || !canRecover || busy || evidence.trim().length === 0
      || resolution === 'adopt' && !canAdopt) return;
    await controller.mutate({ action: 'resolve', workflowId: attempt.workflowId, taskId: attempt.taskId, attemptId: attempt.attemptId,
      generation: attempt.generation, resolution, evidence: evidence.trim(), commit: resolution === 'adopt' && commit.trim() ? commit.trim() : null,
      releaseRisk: resolution === 'abandon' && releaseRisk });
  }
</script>

<aside class="min-w-0 overflow-y-auto border-l border-border bg-card p-4" aria-label="Task inspector">
  <div class="mb-3 flex items-start justify-between gap-2"><h2 class="min-w-0 break-words text-sm font-semibold">{row.task.title}</h2>
    <button class="shrink-0 rounded p-1 hover:bg-accent" title="Close task inspector" aria-label="Close task inspector" onclick={onclose}><X class="size-4" /></button></div>
  <WorkflowStatus phase={row.phase} />
  {#if history}<p class="mt-2 text-xs text-muted-foreground">{row.current ? 'Exact attempt' : 'Historical attempt'} / Plan {history.attempt.planRevision} / Generation {history.attempt.generation}</p>{/if}
  <dl class="mt-4 space-y-3 text-xs">
    <div><dt class="text-muted-foreground">Kind</dt><dd>{row.task.spec.kind}</dd></div>
    <div><dt class="text-muted-foreground">Dependencies</dt><dd class="break-words">{row.task.dependsOn.join(', ') || 'None'}</dd></div>
    {#if 'target' in row.task.spec}
      <div><dt class="text-muted-foreground">Executor</dt><dd class="break-all">{row.task.spec.target.executorId}</dd></div>
      <div><dt class="text-muted-foreground">Repository</dt><dd class="break-all">{row.task.spec.target.projectPath}</dd></div>
      <div><dt class="text-muted-foreground">Approved root</dt><dd class="break-all font-mono">{row.task.spec.target.baseCommit}</dd></div>
    {/if}
    {#if row.task.spec.kind === 'command'}<div><dt class="text-muted-foreground">Command</dt><dd><pre class="whitespace-pre-wrap break-words">{row.task.spec.command}</pre></dd></div>{/if}
  </dl>
  {#if row.current?.blockedReason}<p class="mt-4 text-xs text-status-warning-foreground">{row.current.blockedReason}</p>{/if}
  {#each artifacts as artifact (artifact.id)}
    <section class="mt-4 space-y-2 border-t border-border pt-3 text-xs">
      <h3 class="font-semibold">{artifact.kind} / {artifact.outcome}</h3>
      <p class="text-muted-foreground">{artifact.provenance} / output {artifact.receivedOutputCoverage}</p>
      <p class="whitespace-pre-wrap break-words">{artifact.summary}</p>
      {#if artifact.commit}<code class="block break-all">{artifact.commit}</code>{/if}
      {#if artifact.git && artifact.commit && artifact.executorId}<button class="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1.5 hover:bg-accent"
        onclick={() => { diff = artifact; }}><GitCompareArrows class="size-3" />Inspect diff</button>{/if}
      {#if artifact.commandOutcome}<pre class="whitespace-pre-wrap break-words">{JSON.stringify(artifact.commandOutcome, null, 2)}</pre>{/if}
      {#if artifact.url && /^https?:\/\//u.test(artifact.url)}<a class="inline-flex items-center gap-1 underline" href={artifact.url} target="_blank" rel="noreferrer noopener"><ExternalLink class="size-3" />Pull request</a>{/if}
      {#if artifact.git?.scope === 'managed-integration'}<p>Inputs: {artifact.git.inputs.length}</p>{/if}
    </section>
  {/each}
  <section class="mt-4 border-t border-border pt-3"><h3 class="text-xs font-semibold">Attempts</h3>
    {#each attempts as attempt (attempt.attemptId)}
      <div class="space-y-2 border-b border-border py-3 text-xs">
        <p class="flex justify-between gap-2"><span>{attempt.resolution}</span><span>Generation {attempt.generation}</span></p>
        <p class="break-words text-muted-foreground">{attempt.result?.detail ?? attempt.dispatchPhase}</p>
        <time class="block text-muted-foreground">{new Date(attempt.createdAt).toLocaleString()}</time>
        {#if !history}<button class="rounded border border-border px-2 py-1.5 hover:bg-accent" onclick={() => void controller.inspectAttempt(attempt.attemptId)}>Inspect exact attempt</button>{/if}
        {#if attempt.chatId}<button class="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1.5 hover:bg-accent" onclick={() => onOpenChat(attempt.chatId!)}><MessageSquare class="size-3" />Worker chat</button>{/if}
        {#if attempt.managedTarget && (controller.detail?.workflow.archived || controller.detail?.workflow.desired === 'canceled')
          && resources.some(claim => claim.attemptId === attempt.attemptId && claim.resourceKey === attempt.managedTarget?.resourceKey
            && claim.retained && !claim.quarantined && !claim.riskReleased)}
          <button class="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1.5 hover:bg-accent disabled:opacity-40" disabled={!canRecover || busy}
            onclick={() => { cleanup = attempt; cleanupHead = artifacts.find(artifact => artifact.attempt.attemptId === attempt.attemptId && artifact.commit)?.commit
              ?? attempt.managedTarget!.head; cleanupConfirmed = false; }}><Trash2 class="size-3" />Remove worktree</button>
        {/if}
      </div>
    {:else}<p class="mt-2 text-xs text-muted-foreground">No attempts</p>{/each}
    {#if !history && controller.hasMoreAttempts}<button class="mt-3 rounded border border-border px-2 py-1.5 text-xs" disabled={controller.loadingHistory}
      onclick={() => void controller.loadHistory('attempts')}>Older attempts</button>{/if}
  </section>
  {#if operations.length}
    <section class="mt-4 space-y-2 border-t border-border pt-3 text-xs"><h3 class="font-semibold">Repository operations</h3>
      {#each operations as operation (operation.id)}
        <div class="space-y-1 border-b border-border py-2"><p>{operation.kind}{operation.stage ? ` / ${operation.stage}` : ''}: {operation.status}</p>
          {#if operation.detail}<p class="break-words text-muted-foreground">{operation.detail}</p>{/if}
          {#if operation.kind === 'publication' && operation.stage === 'create' && ['unknown', 'succeeded'].includes(operation.status)
            && attempts.some(attempt => attempt.attemptId === operation.attemptId && attempt.resolution === 'unknown')}
            <button class="rounded border border-border px-2 py-1.5 disabled:opacity-40" disabled={!canRecover || busy}
              onclick={() => void controller.mutate({ action: 'recheck-publication', workflowId: controller.detail!.workflow.id,
                attemptId: operation.attemptId, publicationOperationId: operation.id })}>Recheck original PR</button>
          {/if}
        </div>
      {/each}
    </section>
  {/if}
  {#if matchingInspection && row.current?.attempt && ['failed', 'interrupted'].includes(row.phase) && row.current.hold === 'none'}
    {@const attempt = row.current.attempt}
    <button class="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40"
      disabled={!canDecide || busy} onclick={() => void controller.mutate({ action: 'retry', workflowId: attempt.workflowId,
        taskId: attempt.taskId, generation: attempt.generation, attemptId: attempt.attemptId })}><RotateCcw class="size-4" />New generation</button>
  {/if}
  {#if matchingInspection && resolutionAttempt && row.phase === 'outcome-unknown'}
    <form class="mt-4 space-y-3 border-t border-border pt-3" onsubmit={(event) => { event.preventDefault(); void resolve(); }}>
      <h3 class="text-sm font-semibold">Resolve uncertainty</h3>
      <label class="block text-xs">Decision<select class="mt-1 w-full rounded border border-border bg-background p-2 text-base" bind:value={resolution}>
        <option value="abandon">Abandon uncertain attempt</option>
        <option value="not-started">Confirm nothing started</option>
        {#if canAdopt}<option value="adopt">Adopt independently verified output</option>{/if}
      </select></label>
      {#if resolution === 'adopt' && row.task.spec.kind === 'agent'}<label class="block text-xs">Exact commit<input class="mt-1 w-full rounded border border-border bg-background p-2 font-mono text-base"
        bind:value={commit} required pattern="[0-9a-f]{40}|[0-9a-f]{64}" /></label>{/if}
      <label class="block text-xs">Evidence<textarea class="mt-1 min-h-20 w-full rounded border border-border bg-background p-2 text-base" bind:value={evidence} required maxlength="4096"></textarea></label>
      {#if resolution === 'abandon'}<label class="flex items-start gap-2 text-xs"><input type="checkbox" bind:checked={releaseRisk} />
        Acknowledge remaining resource risk and permit a fresh generation. Previous effects may still be running.</label>{/if}
      <button class="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40" disabled={!canRecover || busy || !evidence.trim()}>Record resolution</button>
    </form>
  {/if}
  {#if matchingInspection && row.current && canClearHold}
    <form class="mt-4 space-y-3 border-t border-border pt-3" onsubmit={(event) => {
      event.preventDefault();
      if (matchingInspection && canClearHold && canRecover && !busy && evidence.trim() && controller.detail && row.current) void controller.mutate({ action: 'clear-hold',
        workflowId: controller.detail.workflow.id, taskId: row.task.id, generation: row.current.generation, evidence: evidence.trim() });
    }}>
      <label class="block text-xs">Resolution evidence<textarea class="mt-1 min-h-20 w-full rounded border border-border bg-background p-2 text-base" bind:value={evidence} required maxlength="4096"></textarea></label>
      <button class="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40" disabled={!canRecover || busy || !evidence.trim()}>Clear admission hold</button>
    </form>
  {/if}
</aside>
<Dialog open={cleanup !== null} onOpenChange={(open) => { if (!open && !controller.pending) cleanup = null; }}>
  <DialogContent><DialogTitle>Remove retained worktree?</DialogTitle>
    <DialogDescription>The branch, ownership marker and evidence remain. Ignored files are removed with the worktree. Stop background tools and detached jobs first; idle providers do not enumerate them. Active tasks, terminals, dirty files, runtime replacement or uncertain ownership block removal.</DialogDescription>
    <form class="space-y-3" onsubmit={async event => {
      event.preventDefault();
      if (!cleanup?.managedTarget || !cleanupConfirmed || !canRecover || busy) return;
      if (await controller.mutate({ action: 'cleanup', workflowId: cleanup.workflowId, attemptId: cleanup.attemptId,
        resourceKey: cleanup.managedTarget.resourceKey, expectedHead: cleanupHead.trim() })) cleanup = null;
    }}>
      <p class="break-all text-xs">{cleanup?.managedTarget?.target.executorId} / {cleanup?.managedTarget?.target.projectPath}</p>
      <label class="block text-sm">Expected HEAD<input class="mt-1 w-full rounded border border-border bg-background p-2 font-mono text-base" bind:value={cleanupHead}
        required pattern="[0-9a-f]{40}|[0-9a-f]{64}" /></label>
      <label class="flex items-start gap-2 text-sm"><input type="checkbox" bind:checked={cleanupConfirmed} />Remove this worktree and its ignored files.</label>
      <DialogFooter><button type="button" class="rounded border border-border px-3 py-2" disabled={controller.pending} onclick={() => { cleanup = null; }}>Cancel</button>
        <button class="rounded border border-border px-3 py-2 disabled:opacity-40" disabled={!canRecover || busy || !cleanupConfirmed}>Remove worktree</button></DialogFooter>
    </form>
  </DialogContent>
</Dialog>
{#if diff?.git && diff.commit && diff.executorId}
  {#await diffRenderer() then WorkflowDiff}
    <WorkflowDiff target={{ executorId: diff.executorId, projectPath: diff.git.projectPath }} base={diff.git.inputCommit}
      head={diff.commit} onclose={() => { diff = null; }} />
  {/await}
{/if}
