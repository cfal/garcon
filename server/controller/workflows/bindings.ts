import { isRecord, type JsonObject, type JsonValue } from '../../../common/json.js';
import { replaceWorkflowPlaceholders } from '../../../common/workflow-definition/prompt.js';
import {
  WORKFLOW_TURN_COMPLETED, workflowCommandEnvName, type WorkflowAgentStep, type WorkflowCommandStep,
  type WorkflowDefinition, type WorkflowSignalDefinition, type WorkflowStep, type WorkflowValueType,
} from '../../../common/workflow-definition.js';
import {
  inheritedWorkflowPath, type WorkflowAgentSettings, type WorkflowExecutionContext, type WorkflowLocation, type WorkflowStepSettings,
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
  const projectPath = step.projectPath ?? inheritedWorkflowPath(context, executorId);
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
    signals: _signals, prompt: _prompt, bindings: _bindings, attachments, tags, ...authored
  } = step;
  const resolved = Object.fromEntries(Object.entries(snapshot?.(step, location) ?? {}).filter(([, value]) => value !== undefined));
  return { kind: 'agent', ...authored, ...resolved,
    ...(attachments !== undefined && { attachments }), ...(tags !== undefined && { tags }) };
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

function signalInstructions(step: WorkflowAgentStep): string {
  const signals = Object.entries(step.signals ?? {}).filter(([name]) => name !== WORKFLOW_TURN_COMPLETED);
  if (!signals.length) return '';
  const lines = [
    'Garcon workflow signals',
    'Emit only the signals below as standalone raw tags in assistant output, without surrounding prose, Markdown blockquotes, or code fences. Separate multiple tags with blank lines. Never emit via Shell or tools.',
    `Replace TEXT_PAYLOAD with plain text or JSON_PAYLOAD with valid JSON. For many signals, use a distinct, stable string in the declared key field for each item. Never emit ${WORKFLOW_TURN_COMPLETED}; Garcon emits it on confirmed success.`,
  ];
  for (const [name, signal] of signals) {
    const qualified = `${step.id}.${name}`;
    const key = signal.delivery === 'many' ? `; key: ${signal.key}` : '';
    const fields = signal.payload === 'json' ? Object.entries(signal.fields ?? {}) : [];
    const required = fields.length ? `; required fields: ${fields.map(([field, type]) => `${field}: ${type}`).join(', ')}` : '';
    const tag = `<garcon-workflow-emit signal="${qualified}" content-type="${signal.payload}"`;
    lines.push('', `${qualified} (${signal.payload}, ${signal.delivery}${key}${required})`, signal.payload === 'none'
      ? `${tag} />`
      : `${tag}>${signal.payload === 'text' ? 'TEXT_PAYLOAD' : 'JSON_PAYLOAD'}</garcon-workflow-emit>`);
  }
  return '\n\n' + lines.join('\n');
}

function resolveBindings(
  step: WorkflowStep,
  inputs: JsonObject,
  signal: JsonValue | undefined,
  all: (stepId: string) => JsonValue,
): {
  bindings: JsonObject;
  bindingsJson: string;
  replacements: Map<string, { text: string; bytes: number }>;
} {
  let bindingBytes = 2;
  const entries: [string, JsonValue][] = [];
  const replacements = new Map<string, { text: string; bytes: number }>();
  for (const [name, binding] of Object.entries(step.bindings ?? {})) {
    let value: JsonValue | undefined;
    switch (binding.kind) {
      case 'input': value = inputs[binding.input]; break;
      case 'all': value = all(binding.stepId); break;
      case 'signal':
        if (binding.field === undefined) value = signal;
        else if (isRecord(signal) && Object.hasOwn(signal, binding.field)) value = signal[binding.field];
        break;
    }
    if (value === undefined) throw new WorkflowBindingError(`Binding "${name}" requires a complete signal payload.`);
    const text = JSON.stringify(value);
    bindingBytes += Buffer.byteLength(text) + Buffer.byteLength(name) + 4;
    if (bindingBytes > WORKFLOW_LIMITS.promptBytes) throw new WorkflowBindingError('Bindings exceed the size limit.');
    const replacement = typeof value === 'string' ? value : text;
    replacements.set(name, { text: replacement, bytes: Buffer.byteLength(replacement) });
    entries.push([name, value]);
  }
  const bindings = Object.fromEntries(entries);
  return { bindings, bindingsJson: JSON.stringify(bindings), replacements };
}

function quoteCommandEnvAssignment(shell: string | undefined, envName: string, value: string): string {
  if (shell === 'notes' || shell === 'notes-markdown') {
    throw workflowInvalid('Command bindings require an executable shell rather than Notes mode.');
  }
  if (value.includes('\0') || !value.isWellFormed()) {
    throw workflowInvalid(`Binding "${envName}" contains characters a shell environment variable cannot carry.`);
  }
  if (shell === 'fish') {
    const quoted = `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
    return `set -gx ${envName} ${quoted}`;
  }
  return `export ${envName}='${value.replaceAll("'", "'\\''")}'`;
}

export function wrapCommandWithBindings(command: string, shell: string | undefined, bindings: JsonObject): string {
  const entries = Object.entries(bindings);
  if (!entries.length) return command;
  const prologue: string[] = [];
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    const envName = workflowCommandEnvName(name);
    if (seen.has(envName)) throw workflowInvalid(`Command binding "${envName}" collides with another binding.`);
    seen.add(envName);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    prologue.push(quoteCommandEnvAssignment(shell, envName, text));
  }
  return `${prologue.join('\n')}\n${command}`;
}

export function bindCommand(
  step: WorkflowCommandStep,
  inputs: JsonObject,
  signal: JsonValue | undefined,
  all: (stepId: string) => JsonValue,
): { bindingsJson: string; bytes: number } {
  const { bindings, bindingsJson } = resolveBindings(step, inputs, signal, all);
  let wrapped: string;
  try {
    wrapped = wrapCommandWithBindings(step.command, step.shell, bindings);
  } catch (error) {
    throw new WorkflowBindingError(error instanceof Error ? error.message : 'Invalid command binding value.');
  }
  const bytes = Buffer.byteLength(wrapped);
  if (bytes > WORKFLOW_LIMITS.promptBytes) throw new WorkflowBindingError('Rendered command exceeds the size limit.');
  return { bindingsJson, bytes: bytes + Buffer.byteLength(bindingsJson) };
}

export function bindPrompt(
  step: Exclude<WorkflowStep, { kind: 'command' }>,
  inputs: JsonObject,
  signal: JsonValue | undefined,
  all: (stepId: string) => JsonValue,
): { prompt: string; bindingsJson: string; bytes: number } {
  const { bindingsJson, replacements } = resolveBindings(step, inputs, signal, all);
  let promptBytes = Buffer.byteLength(step.prompt);
  const authored = replaceWorkflowPlaceholders(step.prompt, (matched, name) => {
    const replacement = replacements.get(name);
    if (!replacement) throw new WorkflowBindingError(`Missing binding "${name}".`);
    promptBytes += replacement.bytes - Buffer.byteLength(matched);
    if (promptBytes > WORKFLOW_LIMITS.promptBytes) throw new WorkflowBindingError('Rendered prompt exceeds the size limit.');
    return replacement.text;
  });
  const instructions = step.kind === 'agent' ? signalInstructions(step) : '';
  promptBytes += Buffer.byteLength(instructions);
  if (promptBytes > WORKFLOW_LIMITS.promptBytes) throw new WorkflowBindingError('Rendered prompt exceeds the size limit.');
  return { prompt: authored + instructions, bindingsJson, bytes: promptBytes + Buffer.byteLength(bindingsJson) };
}
