import { AntigravityAcpEventConverter } from '../antigravity-acp-event-converter.ts';

export function textBlock(text: string) {
  return { type: 'content', content: { type: 'text', text } };
}

export function session() {
  const converter = new AntigravityAcpEventConverter();
  const context = { chatId: 'chat', sessionId: 'session', timestamp: 'now' };
  function frame(update: Record<string, unknown>) {
    return converter.fromSessionUpdate({ update }, context);
  }
  return {
    frame,
    start: (id: string, data: Record<string, unknown>) => frame({ toolCallId: id, sessionUpdate: 'tool_call', ...data }),
    patch: (id: string, data: Record<string, unknown>) => frame({ toolCallId: id, sessionUpdate: 'tool_call_update', ...data }),
    permission: (id: string, data = {}) => converter.permissionToolUse({ toolCallId: id, ...data }, context),
    end: () => converter.endTurn(context.sessionId, context),
  };
}
