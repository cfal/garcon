import { applyWorkflowFieldEdits } from './workflow-definition/edit.js';
import { validateWorkflowGraph, validateWorkflowStepAddition } from './workflow-definition/graph.js';
import { readWorkflowDefinition, readWorkflowStep } from './workflow-definition/schema.js';
import { readWorkflowSource } from './workflow-definition/source.js';
import type {
  WorkflowDefinition, WorkflowDefinitionEditResult, WorkflowDefinitionParseResult, WorkflowFieldEdit,
  WorkflowStepAdditionOptions, WorkflowStepAdditionParseResult,
} from './workflow-definition/types.js';

export { getWorkflowStepSignal } from './workflow-definition/graph.js';
export { renderWorkflowPrompt } from './workflow-definition/prompt.js';
export { WORKFLOW_DEFINITION_LIMITS, WORKFLOW_TURN_COMPLETED } from './workflow-definition/types.js';
export type {
  WorkflowAgentStep,
  WorkflowAttachment,
  WorkflowBinding,
  WorkflowCommandStep,
  WorkflowDecisionStep,
  WorkflowDefinition,
  WorkflowDefinitionEditResult,
  WorkflowDefinitionParseResult,
  WorkflowDiagnostic,
  WorkflowDiagnosticCode,
  WorkflowFieldEdit,
  WorkflowFieldPath,
  WorkflowInput,
  WorkflowSignalDefinition,
  WorkflowSignalReference,
  WorkflowSourcePosition,
  WorkflowSourceRange,
  WorkflowStep,
  WorkflowStepAdditionOptions,
  WorkflowStepAdditionParseResult,
  WorkflowSubscription,
  WorkflowValueType,
} from './workflow-definition/types.js';

function readValidatedDefinition(text: string) {
  const { source, root } = readWorkflowSource(text, 'definition');
  const definition = root && readWorkflowDefinition(root);
  if (root && definition && !source.diagnostics.length) validateWorkflowGraph(definition, root);
  return { definition: source.diagnostics.length ? null : definition, source };
}

export function parseWorkflowDefinition(text: string): WorkflowDefinitionParseResult {
  const { definition, source } = readValidatedDefinition(text);
  return { definition, diagnostics: source.diagnostics };
}

export function parseWorkflowStepAddition(
  base: WorkflowDefinition, text: string, { evidence }: WorkflowStepAdditionOptions = {},
): WorkflowStepAdditionParseResult {
  const { source, root } = readWorkflowSource(text, 'step');
  const step = root && readWorkflowStep(root);
  if (root && step && !source.diagnostics.length) validateWorkflowStepAddition(base, step, root, evidence);
  return { step: source.diagnostics.length ? null : step, diagnostics: source.diagnostics };
}

/** Applies scalar edits atomically; invalid source or an invalid candidate is never rewritten. */
export function editWorkflowDefinition(text: string, edits: readonly WorkflowFieldEdit[]): WorkflowDefinitionEditResult {
  const { definition, source } = readValidatedDefinition(text);
  if (!definition) return { source: text, definition, diagnostics: source.diagnostics };
  const candidate = applyWorkflowFieldEdits(source, edits);
  if (candidate === null) return { source: text, definition: null, diagnostics: source.diagnostics };
  if (candidate === text) return { source: text, definition, diagnostics: [] };
  const parsed = parseWorkflowDefinition(candidate);
  return parsed.definition ? { ...parsed, source: candidate } : { ...parsed, source: text, attemptedSource: candidate };
}
