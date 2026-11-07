<script lang="ts">
  import { untrack } from 'svelte';
  import type { GitProjectTarget } from '$lib/api/git-client.js';
  import { GitComparisonController } from '$lib/git/review/git-comparison.svelte.js';
  import GitComparisonScreen from '$lib/components/git/GitComparisonScreen.svelte';
  import { Dialog, DialogContent, DialogTitle, DialogDescription } from '$lib/components/ui/dialog';
  let { target, base, head, onclose }: { target: GitProjectTarget; base: string; head: string; onclose: () => void } = $props();
  const comparison = new GitComparisonController();
  $effect(() => {
    const project = target;
    const fromRevision = base;
    const toRevision = head;
    untrack(() => {
      comparison.setSpecification({ fromRevision, toKind: 'revision', toRevision, mode: 'direct' });
      void comparison.compare(project);
    });
    return () => comparison.reset();
  });
</script>

<Dialog open onOpenChange={(open) => { if (!open) onclose(); }}>
  <DialogContent class="flex h-[90dvh] max-h-[90dvh] flex-col overflow-hidden sm:max-w-[90vw]">
    <DialogTitle>Artifact diff</DialogTitle>
    <DialogDescription class="break-all">{target.executorId}: {target.projectPath}</DialogDescription>
    <div class="flex min-h-0 flex-1 flex-col">
      <GitComparisonScreen {comparison} isLoading={comparison.isLoading} presentation="mobile" fontSize={12}
        onRefresh={() => void comparison.compare(target)} onOpenChat={onclose} />
    </div>
  </DialogContent>
</Dialog>
