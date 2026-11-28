import { CursorAcpEventConverter } from '../../../../server-agents/cursor/src/agents/cursor/cursor-acp-event-converter.ts';
import type { AcpEventConverter } from '../../../../server-agents/common/src/acp/event-converter.ts';
import type { PermissionDecisionPayload } from '../../../../common/chat-command-contracts.ts';

export type EventStep =
  | ['beginTurn' | 'releaseSession', string]
  | ['endTurn', ...Parameters<NonNullable<AcpEventConverter['endTurn']>>]
  | ['fromSessionUpdate', ...Parameters<AcpEventConverter['fromSessionUpdate']>]
  | ['permissionToolUse', ...Parameters<NonNullable<AcpEventConverter['permissionToolUse']>>]
  | ['customRequestToolUse', ...Parameters<NonNullable<AcpEventConverter['customRequestToolUse']>>, PermissionDecisionPayload[]?];

export function scriptedCursorEvents(steps: EventStep[]) {
  const converter = new CursorAcpEventConverter();
  return steps.map(step => {
    switch (step[0]) {
      case 'beginTurn': return converter.beginTurn(step[1]);
      case 'releaseSession': return converter.releaseSession(step[1]);
      case 'endTurn': return converter.endTurn(step[1], step[2]);
      case 'fromSessionUpdate': return converter.fromSessionUpdate(step[1], step[2]);
      case 'permissionToolUse': return converter.permissionToolUse(step[1], step[2]);
      case 'customRequestToolUse': {
        const result = converter.customRequestToolUse(step[1], step[2]);
        if (!result) return null;
        return {
          tool: result.tool,
          decisions: (step[3] ?? []).map(decision => result.responseForDecision(decision)),
          cancelled: result.responseForCancellation('cancelled'),
        };
      }
    }
  }).map(value => value === undefined ? null : JSON.parse(JSON.stringify(value)));
}
