import type { AgentExecutionAdmission } from '@garcon/server-agent-interface';

export function assertExecutionOpen(admission: AgentExecutionAdmission): void {
  admission.signal.throwIfAborted();
}

export function markExecutionStarted(admission: AgentExecutionAdmission): void {
  assertExecutionOpen(admission);
  admission.markStarted();
}

export function markExecutionAbortable(admission: AgentExecutionAdmission): void {
  assertExecutionOpen(admission);
  admission.markAbortable();
}
