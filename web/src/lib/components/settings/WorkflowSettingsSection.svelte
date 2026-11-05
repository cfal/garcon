<script lang="ts">
  import { getRemoteSettings, getWorkspaceCoordinator } from '$lib/context';
  import { Switch } from '$lib/components/ui/switch';
  import { workflowApi } from '$lib/api/workflows.js';
  const remoteSettings = getRemoteSettings();
  const workspace = getWorkspaceCoordinator();
  let saving = $state(false);
  let error = $state<string | null>(null);
  const enabled = $derived(remoteSettings.snapshot?.features.workflows.enabled === true);
  async function toggle(next: boolean) {
    if (saving) return;
    saving = true; error = null;
    try { await workflowApi.setEnabled(next); await remoteSettings.refresh(); }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally { saving = false; }
  }
</script>

<section class="space-y-3 border-t border-border py-3" aria-label="Workflow settings">
  <div class="flex items-center justify-between gap-4">
    <label class="text-sm font-medium" for="workflows-enabled">Workflows</label>
    <Switch id="workflows-enabled" checked={enabled} disabled={saving} onCheckedChange={(checked) => void toggle(checked)} />
  </div>
  <button class="text-sm underline" onclick={() => void workspace.openSingleton('workflows')}>{enabled ? 'Open workflows' : 'Workflow history and recovery'}</button>
  {#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
</section>
