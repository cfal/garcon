import type { SettingsStore } from '../../settings/store.js';
import { WorkflowRuntime } from '../setup.js';
import { WorkflowSettings } from '../settings.js';
import { createWorkflowEngine } from './engine.js';
export { createWorkflowProviderReferences } from '../setup.js';

export function composeWorkflows(workspaceDir: string, settings: SettingsStore,
  deps: Omit<Parameters<typeof createWorkflowEngine>[1], 'onFailure'>,
  onUnavailable: (error: unknown) => void) {
  const workflows = new WorkflowRuntime(workspaceDir, {
    storageInitialized: () => settings.hasInitializedWorkflowStorage(),
    markStorageInitialized: () => settings.markWorkflowStorageInitialized(),
    onInvalidated: deps.onInvalidated,
    createEngine: (store, onFailure) => createWorkflowEngine(store, { ...deps, onFailure }),
  });
  return { workflows, workflowSettings: new WorkflowSettings(settings, workflows),
    async startWorkflows() {
      if (settings.getFeatureSettings().workflows.enabled) await workflows.enable().catch(onUnavailable);
    } };
}
