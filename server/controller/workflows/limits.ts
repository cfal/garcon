import { WORKFLOW_DEFINITION_LIMITS } from '../../../common/workflow-definition.js';

export const WORKFLOW_LIMITS = {
  definitionsPage: 100,
  runsPage: 100,
  activeChatsPage: 100,
  globalAttempts: 16,
  steps: WORKFLOW_DEFINITION_LIMITS.steps,
  repeatInstances: 128,
  attemptsPerInstance: 16,
  explicitSignals: 512,
  operations: 1024,
  sourceBytes: WORKFLOW_DEFINITION_LIMITS.sourceBytes,
  valueBytes: 64 * 1024,
  promptBytes: 128 * 1024,
  stepBytesPerRun: 2 * 1024 * 1024,
  signalBytesPerRun: 2 * 1024 * 1024,
  bindingBytesPerRun: 2 * 1024 * 1024,
} as const;
