import { applyWorkflowEdit } from './workflow-definition/edit.js';
import { validateWorkflowGraph, validateWorkflowStepAddition } from './workflow-definition/graph.js';
import { readWorkflowDefinition, readWorkflowStep } from './workflow-definition/schema.js';
import { readWorkflowSource, type WorkflowField } from './workflow-definition/source.js';
import type { JsonValue } from './json.js';
import {
  WORKFLOW_DEFINITION_LIMITS,
  type WorkflowDefinition, type WorkflowDefinitionEdit, type WorkflowDefinitionEditResult, type WorkflowDefinitionParseResult,
  type WorkflowFieldPath, type WorkflowStepAdditionOptions, type WorkflowStepAdditionParseResult,
} from './workflow-definition/types.js';

export { getWorkflowStepSignal } from './workflow-definition/graph.js';
export { renderWorkflowPrompt } from './workflow-definition/prompt.js';
export {
  isWorkflowName, WORKFLOW_DEFINITION_LIMITS, WORKFLOW_TURN_COMPLETED, WORKFLOW_VALUE_TYPES, workflowCommandEnvName,
} from './workflow-definition/types.js';
export type {
  WorkflowAgentStep,
  WorkflowAttachment,
  WorkflowBinding,
  WorkflowCommandStep,
  WorkflowDecisionStep,
  WorkflowDefinition,
  WorkflowDefinitionEdit,
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

function validateDefinition(root: WorkflowField | null): WorkflowDefinition | null {
  if (!root || root.source.diagnostics.length) return null;
  const definition = readWorkflowDefinition(root);
  if (definition && !root.source.diagnostics.length) validateWorkflowGraph(definition, root);
  return root.source.diagnostics.length ? null : definition;
}

export function parseWorkflowDefinition(text: string): WorkflowDefinitionParseResult {
  const { root, source } = readWorkflowSource(text, 'definition');
  return { definition: validateDefinition(root), diagnostics: source.diagnostics };
}

export function parseWorkflowStepAddition(
  base: WorkflowDefinition, text: string, { evidence }: WorkflowStepAdditionOptions = {},
): WorkflowStepAdditionParseResult {
  const { source, root } = readWorkflowSource(text, 'step');
  const step = root && readWorkflowStep(root);
  if (root && step && !source.diagnostics.length) validateWorkflowStepAddition(base, step, root, evidence);
  return { step: source.diagnostics.length ? null : step, diagnostics: source.diagnostics };
}

/** Reads the authored YAML shape, before references are normalized for execution. */
export function getWorkflowDefinitionFieldValue(text: string, path: WorkflowFieldPath): JsonValue | undefined {
  const { root } = readWorkflowSource(text, 'definition');
  return root && validateDefinition(root) ? root.atPath(path).value : undefined;
}

/** Applies edits atomically; invalid source or an invalid candidate is never rewritten. */
export function editWorkflowDefinition(text: string, edits: readonly WorkflowDefinitionEdit[]): WorkflowDefinitionEditResult {
  let { root, source } = readWorkflowSource(text, 'definition');
  const original = validateDefinition(root);
  if (!original) return { source: text, definition: null, diagnostics: source.diagnostics };
  if (edits.length > WORKFLOW_DEFINITION_LIMITS.steps * 2) {
    source.issue('invalid-edit', [], `Use at most ${WORKFLOW_DEFINITION_LIMITS.steps * 2} operations in one transaction.`);
    return { source: text, definition: null, diagnostics: source.diagnostics };
  }
  for (const edit of edits) {
    if (!root) break;
    const candidate = applyWorkflowEdit(root, edit);
    if (candidate === null) break;
    if (candidate !== source.text) ({ root, source } = readWorkflowSource(candidate, 'definition'));
  }
  const definition = source.text === text ? original : validateDefinition(root);
  if (!definition || source.diagnostics.length) {
    return { source: text, definition: null, diagnostics: source.diagnostics,
      ...(source.text === text ? {} : { attemptedSource: source.text }) };
  }
  return { source: source.text, definition, diagnostics: [] };
}
