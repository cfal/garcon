import type { AutomationResult } from '../../../common/automation.js';
import { WORKFLOW_LIMITS, type WorkflowPlanTask } from '../../../common/workflows.js';
import type { WorkflowTerminalObservation } from './attempts.js';

export function workflowResultDetail(value: string): string {
  let length = Math.min(value.length, 4096);
  while (Buffer.byteLength(JSON.stringify(value.slice(0, length))) > 8192) length = Math.floor(length / 2);
  return value.slice(0, length);
}

export function workflowTerminalObservation(task: WorkflowPlanTask, terminal: AutomationResult): WorkflowTerminalObservation {
  const observation = classifyTerminal(task, terminal);
  if (Buffer.byteLength(JSON.stringify(observation.result)) <= WORKFLOW_LIMITS.resultBytes) return observation;
  const command = observation.result.commandOutcome;
  return { ...observation, result: { ...observation.result, commandOutcome: command ? { ...command,
    cwd: { kind: 'unavailable', reason: 'Command metadata exceeded the retained evidence limit.' },
    signal: command.signal?.slice(0, 256) ?? null } : null,
    detail: 'Oversized command metadata omitted; exit status retained. ' + workflowResultDetail(observation.result.detail) } };
}

function classifyTerminal(task: WorkflowPlanTask, terminal: AutomationResult): WorkflowTerminalObservation {
  const result = { commandOutcome: terminal.commandOutcome, receivedOutputCoverage: terminal.receivedOutputCoverage,
    outputCaptured: false, certainty: 'unknown' as const, termination: 'unknown' as const, detail: '' };
  if (terminal.kind === 'unavailable') return { resolution: 'unknown', result: { ...result, detail: workflowResultDetail(terminal.reason) } };
  if (terminal.kind === 'interrupted') return { resolution: 'interrupted', result: { ...result,
    certainty: terminal.termination === 'observed' ? 'definite' : 'unknown',
    termination: terminal.termination === 'observed' ? 'observed' : 'unknown', detail: 'The turn was interrupted.' } };
  if (terminal.kind === 'failed' && terminal.certainty === 'not-started') return {
    resolution: 'not-started', result: { ...result, certainty: 'not-started', termination: 'not-started', detail: workflowResultDetail(terminal.detail) },
  };
  if (terminal.kind === 'failed' && terminal.certainty === 'unknown') return {
    resolution: 'unknown', result: { ...result, detail: workflowResultDetail(terminal.detail) },
  };
  // An expected nonzero Shell exit is evaluated with Git and capture evidence, not receipt success.
  if (task.spec.kind === 'command' && terminal.commandOutcome) {
    const command = terminal.commandOutcome;
    if (command.outcome === 'interrupted') return { resolution: 'interrupted', result: { ...result,
      certainty: 'definite', termination: 'observed', detail: 'The command was interrupted.' } };
    if (command.outcome === 'unknown' || command.exitCode === null) return {
      resolution: 'unknown', result: { ...result, detail: 'Command termination could not be established.' },
    };
    return { resolution: 'checking', result: { ...result, certainty: 'definite', termination: 'observed', detail: 'Command termination observed; evidence requires checking.' } };
  }
  if (terminal.kind === 'completed') return { resolution: 'checking', result: { ...result,
    certainty: 'definite', termination: 'observed', detail: 'Turn completed; output requires checking.' } };
  return { resolution: 'failed', result: { ...result, certainty: 'definite', termination: 'observed', detail: workflowResultDetail(terminal.detail) } };
}
