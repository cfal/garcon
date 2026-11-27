import { DomainError } from '../../common/domain-error.js';
import { createLogger } from '../../common/log.js';
import { WorkflowEngine, type WorkflowEngineOptions } from './engine.js';
import { prepareWorkflowSettings, type WorkflowSelectionSource } from './settings.js';
import { WorkflowStore } from './store.js';

export function initializeWorkflows(workspaceDir: string, options: Omit<WorkflowEngineOptions, 'store'>, selections: WorkflowSelectionSource) {
  let engine: WorkflowEngine | null = null;
  const log = createLogger('workflows');
  function disable(reason: string) {
    engine?.close();
    engine = null;
    log.warn(reason);
  }
  const unavailable = () => new DomainError('WORKFLOW_STORAGE_UNAVAILABLE', 'Workflow storage is unavailable until the controller restarts.', 503);
  try {
    engine = new WorkflowEngine({ ...options, store: new WorkflowStore(workspaceDir) });
  } catch {
    disable('Workflows disabled: storage could not open.');
  }
  return {
    get service(): WorkflowEngine {
      if (!engine) throw unavailable();
      return engine;
    },
    prepareSettings: (steps: Parameters<typeof prepareWorkflowSettings>[0], context: Parameters<typeof prepareWorkflowSettings>[1]) =>
      prepareWorkflowSettings(steps, context, selections),
    referencesApiProvider: (id: string) => engine?.referencesApiProvider(id) ?? true,
    referencesExecutor: (id: string) => engine?.referencesExecutor(id) ?? true,
    handleChatRemoved(id: string) {
      // A failed secondary store cannot veto deletion after the chat registry has committed it.
      try { engine?.handleChatRemoved(id); }
      catch { disable('Workflows disabled: could not record chat removal.'); }
    },
    wakeExecutor: (id: string) => engine?.wakeExecutor(id),
    async start() {
      try { await engine?.start(); }
      catch { disable('Workflows disabled: storage recovery failed.'); }
    },
    stop: () => engine?.stop(),
    close: () => engine?.close(),
  };
}

export type WorkflowRuntime = ReturnType<typeof initializeWorkflows>;
