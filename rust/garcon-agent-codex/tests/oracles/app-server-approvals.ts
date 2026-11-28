import {
  buildApprovalMessage as originalBuildApprovalMessage,
  createPendingApproval as originalCreatePendingApproval,
} from '../../../../server-agents/codex/src/agents/codex/app-server/approvals.ts';

export { buildApprovalResponse, isApprovalRequest } from '../../../../server-agents/codex/src/agents/codex/app-server/approvals.ts';

const FIXTURE_TIME = '2026-11-02T00:00:00.000Z';

export function buildApprovalMessage(pending: Parameters<typeof originalBuildApprovalMessage>[0]): unknown {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor() { super(FIXTURE_TIME); }
  } as typeof Date;
  try {
    return JSON.parse(JSON.stringify(originalBuildApprovalMessage(pending)));
  } finally {
    globalThis.Date = RealDate;
  }
}

export function createPendingApproval(...args: Parameters<typeof originalCreatePendingApproval>): unknown {
  const pending = originalCreatePendingApproval(...args);
  return {
    ...pending,
    permissionOccurrenceId: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pending.permissionOccurrenceId),
  };
}
