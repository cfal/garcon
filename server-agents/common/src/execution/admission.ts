import type { AgentExecutionAdmission } from '@garcon/server-agent-interface';

export function assertExecutionOpen(admission: AgentExecutionAdmission): void {
  admission.signal.throwIfAborted();
}

export async function markExecutionStarted(admission: AgentExecutionAdmission): Promise<void> {
  assertExecutionOpen(admission);
  await admission.markStarted();
}
