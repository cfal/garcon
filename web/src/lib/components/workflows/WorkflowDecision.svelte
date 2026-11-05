<script module lang="ts">
  import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
  const diffRenderer = lazyRenderer(() => import('./WorkflowDiff.svelte'));
</script>
<script lang="ts">
  import GitCompareArrows from '@lucide/svelte/icons/git-compare-arrows';
  import type { WorkflowApprovalManifest, WorkflowDetail, WorkflowEvidenceSummary, WorkflowMutation } from '$shared/workflows';
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
  let { detail, gate, evidence, onclose, onsubmit, pending }: { detail: WorkflowDetail; gate: WorkflowApprovalManifest | null;
    evidence?: readonly WorkflowEvidenceSummary[];
    pending: boolean; onclose: () => void; onsubmit: (mutation: WorkflowMutation) => Promise<boolean> } = $props();
  const manifest = $derived(gate ?? detail.activationManifest);
  const digest = $derived(gate ? detail.gates.find(item => item.manifest.gateId === gate.gateId)?.digest : detail.activationDigest);
  const plan = $derived(gate ? detail.active! : detail.draft);
  let acknowledged = $state(false);
  let dialog = $state<HTMLElement | null>(null);
  let inspectDiff = $state(false);
  async function decide(decision: 'approve' | 'reject') {
    if (pending || !digest || decision === 'approve' && !acknowledged) return;
    const mutation: WorkflowMutation = gate
      ? { action: 'approve', workflowId: detail.workflow.id, gateId: gate.gateId, manifestDigest: digest, decision }
      : { action: 'activate', workflowId: detail.workflow.id, manifestDigest: digest };
    if (await onsubmit(mutation)) onclose();
  }
</script>

<Dialog open onOpenChange={(open) => { if (!open && !pending) onclose(); }}>
  <DialogContent bind:ref={dialog} class="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl"
    onOpenAutoFocus={(event) => { event.preventDefault(); dialog?.focus({ preventScroll: true }); }}>
    <DialogHeader><DialogTitle>{gate ? 'Review approval' : 'Activate plan'}: {detail.workflow.title}</DialogTitle>
      <DialogDescription>Plan {plan.revision} / {manifest.gateId}</DialogDescription></DialogHeader>
    <div class="min-h-0 space-y-4 overflow-y-auto">
    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      <dt class="text-muted-foreground">Remote writes</dt><dd>{plan.plan.policy.allowRemoteWrites ? 'Allowed' : 'Not allowed'}</dd>
      <dt class="text-muted-foreground">Concurrency</dt><dd>{plan.plan.policy.concurrency}</dd>
      <dt class="text-muted-foreground">Manifest</dt><dd class="break-all font-mono text-xs">{digest}</dd>
    </dl>
    {#if manifest.publication}
      {@const publication = manifest.publication}
      <section class="space-y-2 border-t border-border pt-3">
        <h3 class="text-sm font-semibold">{publication.title}</h3>
        <p class="break-all text-sm">{publication.remoteUrl}</p>
        <p class="text-sm">{publication.headBranch} to {publication.baseBranch} / {publication.actor.login}</p>
        <code class="block break-all text-xs">{publication.headCommit}</code>
        <button class="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1.5 text-xs" onclick={() => { inspectDiff = true; }}>
          <GitCompareArrows class="size-3" />Inspect approved diff</button>
        <pre class="whitespace-pre-wrap break-words text-sm">{publication.body}</pre>
      </section>
    {/if}
    {#if !gate}
      {#each plan.plan.tasks as task (task.id)}
        <section class="space-y-1 border-t border-border pt-3">
          <h3 class="text-sm font-semibold">{task.title} <span class="font-normal text-muted-foreground">{task.spec.kind}</span></h3>
          {#if 'target' in task.spec}<p class="break-all text-xs text-muted-foreground">{task.spec.target.executorId}: {task.spec.target.projectPath}</p>
            <code class="block break-all text-xs">{task.spec.target.baseCommit}</code>{/if}
          {#if task.spec.kind === 'command'}<pre class="whitespace-pre-wrap break-words text-sm">{task.spec.command}</pre>
          {:else if task.spec.kind === 'agent'}<p class="text-xs">{task.spec.selection.agentId} / {task.spec.selection.model} / {task.spec.selection.permissionMode}</p>
            <pre class="whitespace-pre-wrap break-words text-sm">{task.spec.prompt}</pre>{/if}
        </section>
      {/each}
    {/if}
    {#each manifest.artifacts as artifact (artifact.id)}
      {@const observation = (evidence ?? detail.artifacts).find(item => item.id === artifact.id)}
      <div class="border-t border-border pt-2 text-xs"><p>{observation?.kind ?? artifact.id}: {observation?.summary ?? artifact.digest}</p>
        {#if observation}<p class="text-muted-foreground">{observation.provenance} / {observation.outcome} / output {observation.receivedOutputCoverage}</p>
          {#if 'summaryTruncated' in observation && observation.summaryTruncated}<p class="text-muted-foreground">Summary excerpt</p>{/if}
          {#if observation.commandOutcome}<p>Exit {observation.commandOutcome.exitCode ?? 'unknown'} / {observation.commandOutcome.capture}</p>{/if}
        {/if}
        <code class="break-all">{observation?.commit ?? artifact.digest}</code></div>
    {/each}
    </div>
    <label class="flex shrink-0 items-start gap-2 text-sm"><input type="checkbox" bind:checked={acknowledged} class="mt-1" />
      I approve this exact {gate ? 'manifest' : 'plan, including its commands, permissions and external writes'}.</label>
    <DialogFooter>
      {#if gate}<button class="rounded-md border border-border px-3 py-2 text-sm" disabled={pending} onclick={() => void decide('reject')}>Reject</button>{/if}
      <button class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40" disabled={pending || !acknowledged || !digest}
        onclick={() => void decide('approve')}>{gate ? 'Approve manifest' : 'Activate plan'}</button>
    </DialogFooter>
  </DialogContent>
</Dialog>
{#if inspectDiff && manifest.publication}
  {#await diffRenderer() then WorkflowDiff}
    <WorkflowDiff target={{ executorId: manifest.publication.executorId, projectPath: manifest.publication.projectPath }}
      base={manifest.publication.baseCommit} head={manifest.publication.headCommit} onclose={() => { inspectDiff = false; }} />
  {/await}
{/if}
