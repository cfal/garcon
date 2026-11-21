import { workflowPromptBindingNames } from './prompt.js';
import type { WorkflowField } from './source.js';
import {
  WORKFLOW_DEFINITION_LIMITS, WORKFLOW_TURN_COMPLETED,
  type WorkflowDefinition, type WorkflowSignalDefinition, type WorkflowSignalReference, type WorkflowStep,
} from './types.js';

const COMPLETION = { payload: 'text', delivery: 'once' } as const;
const DECISION_CHOICE = { payload: 'none', delivery: 'once' } as const;

export function getWorkflowStepSignal(step: WorkflowStep, signal: string): WorkflowSignalDefinition | undefined {
  if (step.kind === 'decision') return Object.hasOwn(step.choices, signal) ? DECISION_CHOICE : undefined;
  if (signal === WORKFLOW_TURN_COMPLETED) return COMPLETION;
  return step.kind === 'agent' && step.signals && Object.hasOwn(step.signals, signal) ? step.signals[signal] : undefined;
}

interface Dependency {
  readonly stepId: string;
  readonly field: WorkflowField;
}

function edgeCount(steps: readonly WorkflowStep[]): number {
  let count = 0;
  for (const { on } of steps) {
    if (on) count += on.kind === 'all' ? on.steps.length + 1 : 1;
  }
  return count;
}

export function validateWorkflowGraph(definition: WorkflowDefinition, root: WorkflowField): void {
  const byId = new Map<string, WorkflowStep>();
  const field = root.at('steps');
  definition.steps.forEach((step, index) => {
    if (byId.has(step.id)) {
      field.at(index).at('id').issue('duplicate-id', `Choose a unique step ID; ${JSON.stringify(step.id)} is already used.`);
    } else byId.set(step.id, step);
  });
  if (byId.size !== definition.steps.length || !field.checkCount(edgeCount(definition.steps), 0, WORKFLOW_DEFINITION_LIMITS.edges)) return;

  const dependencies = new Map(definition.steps.map((step, index) => [
    step.id, validateStep(step, field.at(index), definition.inputs, byId),
  ]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (visiting.has(dependency.stepId)) {
        const stack = [...visiting];
        const cycle = stack.slice(stack.indexOf(dependency.stepId)).concat(dependency.stepId);
        dependency.field.issue('cycle', `Break the dependency cycle: ${cycle.join(' -> ')}.`);
      } else visit(dependency.stepId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

export function validateWorkflowStepAddition(
  base: WorkflowDefinition, step: WorkflowStep, field: WorkflowField, evidence: WorkflowSignalReference | undefined,
): void {
  const { steps, edges } = WORKFLOW_DEFINITION_LIMITS;
  if (base.steps.length >= steps) {
    field.issue('invalid-value', `This run already has the maximum of ${steps} steps.`);
    return;
  }
  if (edgeCount(base.steps) + edgeCount([step]) > edges) {
    field.at('on').issue('invalid-value', `Keep the run within ${edges} dependency edges.`);
    return;
  }
  const byId = new Map(base.steps.map((entry) => [entry.id, entry]));
  if (byId.has(step.id)) {
    field.at('id').issue('duplicate-id', `Choose a new step ID; ${JSON.stringify(step.id)} already exists in this run.`);
    return;
  }
  if (step.on && evidence) {
    field.at('on').issue('invalid-subscription', 'Remove the subscription to start this step with the selected stored signal.');
    return;
  }
  validateStep(step, field, base.inputs, byId, evidence);
}

function validateStep(
  step: WorkflowStep,
  field: WorkflowField,
  inputs: WorkflowDefinition['inputs'],
  byId: ReadonlyMap<string, WorkflowStep>,
  evidence?: WorkflowSignalReference,
): Dependency[] {
  const dependencies: Dependency[] = [];
  const on = step.on;
  let triggerSignal: WorkflowSignalDefinition | undefined;
  if (on) {
    const onField = field.at('on');
    const reference = on.kind === 'all' ? on.close : on.signal;
    const referenceField = onField.at(on.kind === 'all' ? 'close' : 'signal');
    const producer = byId.get(reference.stepId);
    if (producer) dependencies.push({ stepId: producer.id, field: referenceField });
    triggerSignal = resolveSignal(step, reference, referenceField, producer);
    if (producer?.on?.kind === 'each') {
      referenceField.issue('invalid-subscription', 'A repeated step cannot be a direct trigger. Join its instances with on.kind: all.');
    }
    if (on.kind === 'all') {
      const joined = new Set<string>();
      if (on.close.signal !== WORKFLOW_TURN_COMPLETED) {
        referenceField.issue('invalid-subscription', 'Close the join with the producer\'s turn_completed signal.');
      }
      on.steps.forEach((id, index) => {
        const item = onField.at('steps').at(index);
        if (joined.has(id)) {
          item.issue('invalid-subscription', 'Remove this duplicate repeat group.');
          return;
        }
        joined.add(id);
        const member = byId.get(id);
        if (!member) {
          item.issue('unknown-step', `Choose an existing repeat step; no step has ID ${JSON.stringify(id)}.`);
          return;
        }
        dependencies.push({ stepId: id, field: item });
        if (member.on?.kind !== 'each' || member.on.signal.stepId !== on.close.stepId) {
          item.issue('invalid-subscription', `Choose an each step subscribed to a signal from ${JSON.stringify(on.close.stepId)}.`);
        }
      });
    } else if (triggerSignal && (on.kind === 'each') !== (triggerSignal.delivery === 'many')) {
      referenceField.issue('invalid-subscription', triggerSignal.delivery === 'many'
        ? 'Subscribe with on.kind: each to start one instance per key.'
        : 'Subscribe with on.kind: once; each requires a keyed many signal.');
    }
  } else if (evidence) {
    const bindings = field.at('bindings');
    triggerSignal = resolveSignal(step, evidence, bindings.value === undefined ? field.at('id') : bindings,
      byId.get(evidence.stepId), 'uses selected evidence from');
  }

  if (step.kind !== 'command') validateBindings(step, field, inputs, triggerSignal, evidence, byId);
  return dependencies;
}

function validateBindings(
  step: Exclude<WorkflowStep, { kind: 'command' }>, field: WorkflowField, inputs: WorkflowDefinition['inputs'],
  triggerSignal: WorkflowSignalDefinition | undefined, evidence: WorkflowSignalReference | undefined, byId: ReadonlyMap<string, WorkflowStep>,
): void {
  const bindings = step.bindings ?? {};
  for (const [name, binding] of Object.entries(bindings)) {
    const entry = field.at('bindings').at(name);
    if (binding.kind === 'input') {
      if (!Object.hasOwn(inputs, binding.input)) {
        entry.issue('invalid-binding', `Declare the input ${JSON.stringify(binding.input)} or bind to an existing input.`);
      }
    } else if (binding.kind === 'all') {
      if (step.on?.kind !== 'all' || !step.on.steps.includes(binding.stepId)) {
        entry.issue('invalid-binding', 'Use all.<step> only for a repeat group listed in this step\'s on.steps join.');
      } else if (byId.get(binding.stepId)?.kind === 'decision') {
        entry.issue('invalid-binding', 'A decision group has no final text. Keep it in the join but remove its output binding.');
      }
    } else if (!step.on && !evidence) {
      entry.issue('invalid-binding', 'Signal bindings require a subscription or a selected stored signal.');
    } else if (triggerSignal?.payload === 'none') {
      entry.issue('invalid-binding', 'This signal carries no payload. Remove the binding or subscribe to a signal with data.');
    } else if (triggerSignal && binding.field !== undefined
      && (triggerSignal.payload !== 'json' || !triggerSignal.fields || !Object.hasOwn(triggerSignal.fields, binding.field))) {
      entry.issue('invalid-binding', `Use the whole signal or declare the JSON field ${JSON.stringify(binding.field)} on the emitting signal.`);
    }
  }
  for (const name of workflowPromptBindingNames(step.prompt)) {
    if (!Object.hasOwn(bindings, name)) {
      field.at('prompt').issue('invalid-binding', `Add a binding for {{${name}}} or remove the placeholder from the prompt.`);
    }
  }
}

function resolveSignal(
  step: WorkflowStep, reference: WorkflowSignalReference, field: WorkflowField, producer: WorkflowStep | undefined,
  action = 'subscribes to',
): WorkflowSignalDefinition | undefined {
  if (!producer) {
    field.issue('unknown-step', `Choose an existing source step; no step has ID ${JSON.stringify(reference.stepId)}.`);
    return undefined;
  }
  const signal = getWorkflowStepSignal(producer, reference.signal);
  if (signal) return signal;
  const names = producer.kind === 'decision' ? Object.keys(producer.choices)
    : [...(producer.kind === 'agent' ? Object.keys(producer.signals ?? {}) : []), WORKFLOW_TURN_COMPLETED];
  const suggestions = names.filter((name) => oneEdit(reference.signal, name));
  const qualified = (name: string) => `${producer.id}.${name}`;
  const correction = suggestions.length === 1 ? `Did you mean ${JSON.stringify(qualified(suggestions[0]))}?`
    : `Choose an emitted signal: ${names.slice(0, 5).map(qualified).join(', ')}${names.length > 5 ? ', ...' : ''}.`;
  field.issue('unknown-signal', `Step ${JSON.stringify(step.id)} ${action} ${JSON.stringify(qualified(reference.signal))}, which ${JSON.stringify(producer.name ?? producer.id)} does not emit. ${correction}`);
  return undefined;
}

function oneEdit(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let index = 0;
  while (index < short.length && short[index] === long[index]) index++;
  if (short.length < long.length) return short.slice(index) === long.slice(index + 1);
  return short.slice(index + 1) === long.slice(index + 1)
    || (short[index] === long[index + 1] && short[index + 1] === long[index] && short.slice(index + 2) === long.slice(index + 2));
}
