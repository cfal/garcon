import { WORKFLOW_DEFINITION_LIMITS } from '../../../common/workflow-definition.js';
import { WORKFLOW_ATTEMPT_LIMIT } from '../../../common/workflow-runs.js';

export const WORKFLOW_LIMITS = {
  definitionsPage: 100,
  runsPage: 100,
  activeChatsPage: 100,
  globalAttempts: 16,
  steps: WORKFLOW_DEFINITION_LIMITS.steps,
  repeatInstances: 128,
  attemptsPerInstance: WORKFLOW_ATTEMPT_LIMIT,
  explicitSignals: 512,
  operations: 1024,
  sourceBytes: WORKFLOW_DEFINITION_LIMITS.sourceBytes,
  promptBytes: 128 * 1024,
  stepBytesPerRun: 2 * 1024 * 1024,
  signalBytesPerRun: 2 * 1024 * 1024,
  bindingBytesPerRun: 2 * 1024 * 1024,
} as const;
