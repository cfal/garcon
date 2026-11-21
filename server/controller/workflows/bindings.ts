import { isRecord, type JsonObject, type JsonValue } from '../../../common/json.js';
import type {
  WorkflowAgentStep, WorkflowDefinition, WorkflowSignalDefinition, WorkflowStep, WorkflowValueType,
} from '../../../common/workflow-definition.js';
import type {
  WorkflowAgentSettings, WorkflowExecutionContext, WorkflowLocation, WorkflowStepSettings,
} from '../../../common/workflow-runs.js';
import { workflowInvalid } from './errors.js';
import { WORKFLOW_LIMITS } from './limits.js';
import { workflowIdentifier, workflowJson } from './requests.js';

function hasValueType(value: JsonValue | undefined, type: WorkflowValueType): value is JsonValue {
  return type === 'json' ? value !== undefined : typeof value === type;
}

export function captureInputs(definition: WorkflowDefinition, provided: JsonObject): string {
  for (const name of Object.keys(provided)) {
    if (!Object.hasOwn(definition.inputs, name)) throw workflowInvalid(`Unknown workflow input "${name}".`);
  }
  const inputs = Object.fromEntries(Object.entries(definition.inputs).map(([name, input]) => {
    const value = Object.hasOwn(provided, name) ? provided[name] : input.default;
    if (!hasValueType(value, input.type)) throw workflowInvalid(`Workflow input "${name}" requires a ${input.type} value.`);
    return [name, value];
  }));
  return workflowJson(inputs, 'Workflow inputs with defaults');
}

export function captureLocation(step: Exclude<WorkflowStep, { kind: 'decision' }>, context: WorkflowExecutionContext): WorkflowLocation {
  const executorId = step.executorId ?? context.defaultTarget?.executorId;
  if (!executorId) throw workflowInvalid(`Step "${step.id}" requires an executor.`);
  const projectPath = step.projectPath
    ?? (context.defaultTarget?.executorId === executorId ? context.defaultTarget.projectPath : undefined)
    ?? context.projectPaths?.[executorId];
  if (!projectPath) throw workflowInvalid(`Step "${step.id}" requires a folder on executor "${executorId}".`);
  return { executorId, projectPath };
}

type SnapshotAgentSettings = (step: WorkflowAgentStep, location: WorkflowLocation) => WorkflowAgentSettings;

export function captureSettings(
  step: Exclude<WorkflowStep, { kind: 'decision' }>,
  location: WorkflowLocation,
  snapshot?: SnapshotAgentSettings,
): WorkflowStepSettings {
  if (step.kind === 'command') return { kind: 'command', shell: step.shell };
  const {
    id: _id, name: _name, kind: _kind, on: _on, executorId: _executor, projectPath: _path,
    signals: _signals, prompt: _prompt, bindings: _bindings, ...authored
  } = step;
  return { kind: 'agent', ...snapshot?.(step, location), ...authored };
}

export function validateSignal(
  definition: WorkflowSignalDefinition,
  key: unknown,
  payload: unknown,
): { key: string; payloadJson: string | null } {
  if (definition.payload === 'none') {
    if (payload !== undefined) throw workflowInvalid('This signal does not accept a payload.');
  } else if (definition.payload === 'text') {
    if (typeof payload !== 'string') throw workflowInvalid('This signal requires a text payload.');
  } else if (payload === undefined) {
    throw workflowInvalid('This signal requires a JSON payload.');
  }

  const payloadJson = payload === undefined ? null : workflowJson(payload, 'Signal payload');
  const value = payloadJson === null ? undefined : JSON.parse(payloadJson) as JsonValue;
  if (definition.payload === 'json' && definition.fields) {
    if (!isRecord(value)) throw workflowInvalid('This signal requires a JSON object with its declared fields.');
    for (const [field, type] of Object.entries(definition.fields)) {
      if (!Object.hasOwn(value, field) || !hasValueType(value[field], type)) {
        throw workflowInvalid(`Signal field "${field}" requires a ${type} value.`);
      }
    }
  }
  if (definition.delivery === 'once') {
    if (key !== undefined) throw workflowInvalid('A once signal must not include a repeat key.');
    return { key: '', payloadJson };
  }
  const derivedKey = workflowIdentifier(isRecord(value) && value[definition.key], 'Repeat key');
  if (key !== undefined && key !== derivedKey) {
    throw workflowInvalid(`Repeat key must match payload field "${definition.key}".`);
  }
  return { key: derivedKey, payloadJson };
}

export class WorkflowBindingError extends Error {}

export function bindPrompt(
  step: Exclude<WorkflowStep, { kind: 'command' }>,
  inputs: JsonObject,
  signal: JsonValue | undefined,
  all: (stepId: string) => JsonValue,
): { prompt: string; bindingsJson: string; bytes: number } {
  const bindings = Object.fromEntries(Object.entries(step.bindings ?? {}).map(([name, binding]) => {
    if (binding.kind === 'input') return [name, inputs[binding.input]];
    if (binding.kind === 'all') return [name, all(binding.stepId)];
    const value = binding.field === undefined
      ? signal
      : isRecord(signal) && Object.hasOwn(signal, binding.field) ? signal[binding.field] : undefined;
    if (value === undefined) throw new WorkflowBindingError(`Binding "${name}" requires a complete signal payload.`);
    return [name, value];
  }));
  let bindingBytes = 2;
  const serialized = Object.fromEntries(Object.entries(bindings).map(([name, value]) => {
    const text = JSON.stringify(value);
    bindingBytes += Buffer.byteLength(text) + Buffer.byteLength(name) + 4;
    if (bindingBytes > WORKFLOW_LIMITS.promptBytes) throw new WorkflowBindingError('Bindings exceed the size limit.');
    return [name, { text, plain: typeof value === 'string' ? value : text }];
  }));
  let promptBytes = Buffer.byteLength(step.prompt);
  const prompt = step.prompt.replace(/\{\{[ \t]*([A-Za-z0-9][A-Za-z0-9_-]{0,127})[ \t]*\}\}/gu, (matched, name: string) => {
    if (!Object.hasOwn(serialized, name)) throw new WorkflowBindingError(`Missing binding "${name}".`);
    const value = serialized[name]!.plain;
    promptBytes += Buffer.byteLength(value) - Buffer.byteLength(matched);
    if (promptBytes > WORKFLOW_LIMITS.promptBytes) throw new WorkflowBindingError('Rendered prompt exceeds the size limit.');
    return value;
  });
  const bindingsJson = JSON.stringify(bindings);
  return { prompt, bindingsJson, bytes: promptBytes + Buffer.byteLength(bindingsJson) };
}
