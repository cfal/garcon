import { AGENT_OPTION_FIELDS, LOCATION_FIELDS, parseAgentOptions, parseWorkflowLocation } from './options.js';
import { encodeWorkflowValue } from '../workflow-value.js';
import type { WorkflowField } from './source.js';
import {
  isWorkflowName, WORKFLOW_DEFINITION_LIMITS, WORKFLOW_TURN_COMPLETED, WORKFLOW_VALUE_TYPES,
  type WorkflowBinding, type WorkflowDefinition, type WorkflowInput, type WorkflowSignalDefinition,
  type WorkflowSignalReference, type WorkflowStep, type WorkflowSubscription,
} from './types.js';

export function readWorkflowDefinition(root: WorkflowField): WorkflowDefinition | null {
  if (!root.map(['version', 'name', 'description', 'inputs', 'steps'])) return null;
  const version = root.at('version');
  if (version.value !== 1) version.expected('the format version 1');
  const name = root.at('name').text(256);
  const description = root.at('description').optional((field) => field.text());
  const inputs = root.at('inputs').optional(readInputs) ?? {};
  const steps = root.at('steps');
  const parsedSteps = steps.list(1, WORKFLOW_DEFINITION_LIMITS.steps)?.flatMap((_, index) => {
    const step = readWorkflowStep(steps.at(index));
    return step ? [step] : [];
  });
  return name && parsedSteps ? { version: 1, name, ...(description === undefined ? {} : { description }),
    inputs, steps: parsedSteps } : null;
}

export function readWorkflowStep(field: WorkflowField): WorkflowStep | null {
  if (!field.map()) return null;
  const kind = field.at('kind').choice(['agent', 'command', 'decision']);
  if (!kind) return null;
  const commonKeys = ['id', 'name', 'kind', 'on'];
  const executionKeys = [...commonKeys, ...LOCATION_FIELDS];
  const id = readName(field.at('id'));
  const name = field.at('name').optional((entry) => entry.text(256));
  const on = field.at('on').optional(readSubscription);
  const common = { ...(name === undefined ? {} : { name }), ...(on === undefined ? {} : { on }) };
  if (kind === 'decision') {
    field.map([...commonKeys, 'prompt', 'bindings', 'choices']);
    const prompt = field.at('prompt').text(WORKFLOW_DEFINITION_LIMITS.promptBytes);
    const bindings = field.at('bindings').optional(readBindings);
    const choicesField = field.at('choices');
    const choices = readNamed(choicesField, (entry) => entry.text(256), 1);
    rejectReservedName(choicesField, choices);
    return id && prompt && choices ? { ...common, id, kind, prompt, choices,
      ...(bindings === undefined ? {} : { bindings }) } : null;
  }

  const execution = { ...common, ...parseWorkflowLocation(field) };
  if (kind === 'command') {
    field.map([...executionKeys, 'command', 'shell', 'bindings']);
    const command = field.at('command').text(WORKFLOW_DEFINITION_LIMITS.promptBytes);
    const shell = field.at('shell').optional((entry) => entry.text(128));
    const bindings = field.at('bindings').optional(readBindings);
    return id && command ? {
      ...execution,
      id,
      kind,
      command,
      ...(shell === undefined ? {} : { shell }),
      ...(bindings === undefined ? {} : { bindings }),
    } : null;
  }

  field.map([...executionKeys, ...AGENT_OPTION_FIELDS, 'prompt', 'bindings', 'signals']);
  const signalsField = field.at('signals');
  const signals = signalsField.optional((entry) => readNamed(entry, readSignal));
  rejectReservedName(signalsField, signals);
  const prompt = field.at('prompt').text(WORKFLOW_DEFINITION_LIMITS.promptBytes);
  const bindings = field.at('bindings').optional(readBindings);
  const options = parseAgentOptions(field);
  return id && prompt ? { ...execution, ...options, id, kind, prompt,
    ...(bindings === undefined ? {} : { bindings }), ...(signals === undefined ? {} : { signals }) } : null;
}

function readName(field: WorkflowField): string | undefined {
  if (typeof field.value === 'string' && isWorkflowName(field.value)) return field.value;
  return field.expected('a name of at most 128 letters, digits, underscores, or hyphens, starting with a letter or digit');
}

function readNamed<T>(field: WorkflowField, read: (entry: WorkflowField) => T | undefined, min = 0): Record<string, T> | undefined {
  const map = field.map();
  if (!map) return undefined;
  const keys = Object.keys(map);
  if (!field.checkCount(keys.length, min, 128)) return undefined;
  const entries: [string, T][] = [];
  for (const key of keys) {
    const entry = field.at(key);
    if (!isWorkflowName(key)) {
      entry.keyIssue('invalid-value', 'Use a name of at most 128 letters, digits, underscores, or hyphens, starting with a letter or digit.');
      continue;
    }
    const value = read(entry);
    if (value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

function rejectReservedName(field: WorkflowField, names: object | undefined): void {
  if (names && Object.hasOwn(names, WORKFLOW_TURN_COMPLETED)) {
    field.at(WORKFLOW_TURN_COMPLETED).keyIssue('invalid-value', 'Rename this signal. Garcon reserves turn_completed for confirmed successful turns.');
  }
}

function readInputs(field: WorkflowField): Record<string, WorkflowInput> | undefined {
  const inputs = readNamed(field, readInput);
  if (!inputs) return;
  const defaults = Object.entries(inputs).flatMap(([name, input]) => input.default === undefined ? [] : [[name, input.default] as const]);
  if (defaults.length && 'issue' in encodeWorkflowValue(Object.fromEntries(defaults))) {
    const target = defaults.length === 1 ? field.at(defaults[0][0]).at('default') : field;
    target.issue('invalid-value', 'Reduce the input defaults to fit the launch JSON size and nesting limits.');
  }
  return inputs;
}

function readInput(field: WorkflowField): WorkflowInput | undefined {
  if (!field.map(['type', 'description', 'default'])) return undefined;
  const type = field.at('type').choice(WORKFLOW_VALUE_TYPES);
  if (!type) return undefined;
  const description = field.at('description').optional((entry) => entry.text());
  const defaultField = field.at('default');
  const value = defaultField.value;
  const base = description === undefined ? {} : { description };
  if (value === undefined) return { ...base, type };
  if (type === 'json') return { ...base, type, default: value };
  if (type === 'string' && typeof value === 'string') return { ...base, type, default: value };
  if (type === 'number' && typeof value === 'number') return { ...base, type, default: value };
  if (type === 'boolean' && typeof value === 'boolean') return { ...base, type, default: value };
  return defaultField.expected(`a ${type}, or omit it to require a launch value`);
}

function readSignal(field: WorkflowField): WorkflowSignalDefinition | undefined {
  if (!field.map(['payload', 'delivery', 'fields', 'key'])) return undefined;
  const payload = field.at('payload').choice(['none', 'text', 'json']);
  const deliveryField = field.at('delivery');
  const delivery = deliveryField.value === undefined ? 'once' : deliveryField.choice(['once', 'many']);
  if (!payload || !delivery) return undefined;
  const fieldsField = field.at('fields');
  const keyField = field.at('key');
  if (delivery === 'once' && keyField.value !== undefined) {
    keyField.issue('invalid-repeat-key', 'Remove the key from this once signal, or declare a keyed JSON signal with delivery: many.');
  }
  if (payload !== 'json') {
    if (fieldsField.value !== undefined) fieldsField.issue('invalid-value', 'Remove fields; only JSON payloads can declare fields.');
    if (delivery === 'many') {
      deliveryField.issue('invalid-repeat-key', 'Use payload: json and declare a string key field for a many signal.');
      return undefined;
    }
    return { payload, delivery };
  }
  const fields = fieldsField.optional((entry) => readNamed(entry, (item) => item.choice(WORKFLOW_VALUE_TYPES), 1));
  if (delivery === 'once') return { payload, delivery, ...(fields === undefined ? {} : { fields }) };

  const key = keyField.value;
  if (typeof key !== 'string' || !isWorkflowName(key) || !fields || !Object.hasOwn(fields, key) || fields[key] !== 'string') {
    keyField.issue('invalid-repeat-key', 'Set key to the name of a declared string field, e.g. key: finding_id.');
    return undefined;
  }
  return { payload, delivery, key, fields };
}

function readSignalReference(field: WorkflowField): WorkflowSignalReference | undefined {
  const parts = typeof field.value === 'string' ? field.value.split('.') : [];
  if (parts.length !== 2 || !parts.every(isWorkflowName)) return field.expected('a step.signal reference, e.g. research.finding_ready');
  return { stepId: parts[0], signal: parts[1] };
}

function readSubscription(field: WorkflowField): WorkflowSubscription | undefined {
  if (!field.map()) return undefined;
  const kind = field.at('kind').choice(['once', 'each', 'all']);
  switch (kind) {
    case 'once': {
      field.map(['kind', 'signal']);
      const signal = readSignalReference(field.at('signal'));
      return signal && { kind, signal };
    }
    case 'each': {
      field.map(['kind', 'signal', 'maxConcurrency']);
      const signal = readSignalReference(field.at('signal'));
      const concurrency = field.at('maxConcurrency');
      const max = WORKFLOW_DEFINITION_LIMITS.repeatConcurrency;
      const value = concurrency.value === undefined ? 1 : concurrency.value;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
        return concurrency.expected(`an integer between 1 and ${max}`);
      }
      return signal && { kind, signal, maxConcurrency: value };
    }
    case 'all': {
      field.map(['kind', 'close', 'steps']);
      const close = readSignalReference(field.at('close'));
      const list = field.at('steps');
      const steps = list.list(1, WORKFLOW_DEFINITION_LIMITS.steps)?.flatMap((_, index) => {
        const id = readName(list.at(index));
        return id === undefined ? [] : [id];
      });
      return close && steps ? { kind, close, steps } : undefined;
    }
    default:
      return undefined;
  }
}

function readBindings(field: WorkflowField): Record<string, WorkflowBinding> | undefined {
  return readNamed(field, (entry): WorkflowBinding | undefined => {
    if (entry.value === 'signal') return { kind: 'signal' };
    if (typeof entry.value === 'string') {
      const parts = entry.value.split('.');
      const [source, name] = parts;
      if (parts.length === 2 && isWorkflowName(name)) {
        if (source === 'inputs') return { kind: 'input', input: name };
        if (source === 'signal') return { kind: 'signal', field: name };
        if (source === 'all') return { kind: 'all', stepId: name };
      }
    }
    entry.issue('invalid-binding', 'Use inputs.<name>, signal, signal.<field>, or all.<step> for a binding.');
    return undefined;
  });
}
