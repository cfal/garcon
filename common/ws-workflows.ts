export class WorkflowInvalidatedMessage {
  readonly type = 'workflow-invalidated' as const;
  constructor(readonly workflowId: string, readonly revision: number) {}
}

export function parseWorkflowInvalidation(data: Record<string, unknown>): WorkflowInvalidatedMessage | null {
  return Object.keys(data).length === 3 && data.type === 'workflow-invalidated'
    && typeof data.workflowId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(data.workflowId)
    && typeof data.revision === 'number' && Number.isSafeInteger(data.revision) && data.revision >= 0
    ? new WorkflowInvalidatedMessage(data.workflowId, data.revision) : null;
}
