import { AntigravityAcpEventConverter } from '../../../../server-agents/antigravity/src/agents/antigravity/antigravity-acp-event-converter.ts';
import type { AcpRuntimeBoundary, AcpSessionUpdateContext } from '../../../../server-agents/common/src/acp/event-converter.ts';
import { packLargeText, unpackLargeText } from './event-text-runs.ts';

export { splitExecutorError } from '../../../../server-agents/antigravity/src/agents/antigravity/antigravity-acp-event-converter.ts';

export type EventStep =
  | ['beginTurn', string]
  | ['fromSessionUpdate' | 'permissionToolUse', Record<string, unknown>, AcpSessionUpdateContext]
  | ['endTurn', string, AcpSessionUpdateContext]
  | ['flushPending', AcpSessionUpdateContext, AcpRuntimeBoundary]
  | ['takeTurnFailure' | 'releaseSession', string];

export function scriptedAntigravityEvents(input: unknown): unknown[] {
  const converter = new AntigravityAcpEventConverter();
  const steps = unpackLargeText(input) as EventStep[];
  return steps.map(step => {
    switch (step[0]) {
      case 'beginTurn': return converter.beginTurn(step[1]);
      case 'fromSessionUpdate': return converter.fromSessionUpdate(step[1], step[2]);
      case 'permissionToolUse': return converter.permissionToolUse(step[1], step[2]);
      case 'endTurn': return converter.endTurn(step[1], step[2]);
      case 'flushPending': return converter.flushPending(step[1], step[2]);
      case 'takeTurnFailure': return converter.takeTurnFailure(step[1]);
      case 'releaseSession': return converter.releaseSession(step[1]);
    }
  }).map(result => result === undefined ? null : JSON.parse(JSON.stringify(packLargeText(result))));
}
