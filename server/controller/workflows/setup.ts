import { DomainError } from '../../common/domain-error.js';
import { createLogger } from '../../common/log.js';
import { WorkflowEngine, type WorkflowEngineOptions } from './engine.js';
import { prepareWorkflowSettings, type WorkflowSelectionSource } from './settings.js';
import { WorkflowStore } from './store.js';

export function initializeWorkflows(workspaceDir: string, options: Omit<WorkflowEngineOptions, 'store'>, selections: WorkflowSelectionSource) {
  let engine: WorkflowEngine | null = null;
  const unavailable = () => new DomainError('WORKFLOW_STORAGE_UNAVAILABLE', 'Workflow storage is unavailable until the controller restarts.', 503);
  try {
    engine = new WorkflowEngine({ ...options, store: new WorkflowStore(workspaceDir) });
  } catch {
    createLogger('workflows').warn('Workflows disabled: storage could not open.');
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
    handleChatRemoved: (id: string) => engine?.handleChatRemoved(id),
    wakeExecutor: (id: string) => engine?.wakeExecutor(id),
    async start() {
      try { await engine?.start(); }
      catch {
        engine?.close();
        engine = null;
        createLogger('workflows').warn('Workflows disabled: storage recovery failed.');
      }
    },
    stop: () => engine?.stop(),
    close: () => engine?.close(),
  };
}

export type WorkflowRuntime = ReturnType<typeof initializeWorkflows>;
