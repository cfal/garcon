import {
  CodexSubagentToolUseMessage,
  type CodexSubagentState,
  type CodexSubagentStatus,
} from '../../../common/chat-types.js';

const FINAL_ANSWER_PATTERN = /^Message Type: FINAL_ANSWER\r?\nTask name: [^\r\n]+\r?\nSender: ([^\r\n]+)\r?\nPayload:\r?\n([\s\S]*)$/;
const SUBAGENT_NOTIFICATION_PATTERN = /<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/;

export function convertCodexSubagentLifecycleText(
  timestamp: string,
  toolId: string,
  text: string,
): CodexSubagentToolUseMessage | null {
  const finalAnswer = FINAL_ANSWER_PATTERN.exec(text.trim());
  if (finalAnswer) {
    const target = finalAnswer[1].trim();
    const state = stateForFinalAnswer(finalAnswer[2]);
    return lifecycleMessage(timestamp, toolId, target, state);
  }

  const notification = SUBAGENT_NOTIFICATION_PATTERN.exec(text);
  if (!notification) return null;
  try {
    const payload = asRecord(JSON.parse(notification[1]));
    const target = stringValue(payload.agent_path) ?? stringValue(payload.agent_id);
    const state = normalizeLegacyAgentStatus(payload.status);
    return target && state ? lifecycleMessage(timestamp, toolId, target, state) : null;
  } catch {
    return null;
  }
}

export function convertCodexSubagentActivity(
  timestamp: string,
  toolId: string,
  kind: 'started' | 'interacted' | 'interrupted',
  agentThreadId: string,
  agentPath: string,
): CodexSubagentToolUseMessage {
  const status: CodexSubagentStatus = kind === 'interrupted' ? 'interrupted' : 'running';
  return new CodexSubagentToolUseMessage(timestamp, toolId, 'agent_status', {
    target: agentPath,
    threadId: agentThreadId,
    agentStates: { [agentPath]: { status } },
  });
}

function lifecycleMessage(
  timestamp: string,
  toolId: string,
  target: string,
  state: CodexSubagentState,
): CodexSubagentToolUseMessage {
  return new CodexSubagentToolUseMessage(timestamp, toolId, 'agent_status', {
    target,
    agentStates: { [target]: state },
  });
}

function stateForFinalAnswer(payload: string): CodexSubagentState {
  const message = payload.trim();
  if (message.startsWith('Agent errored:')) return { status: 'errored', message };
  if (message === 'Agent shut down.') return { status: 'shutdown', message };
  if (message === 'Agent was not found.') return { status: 'notFound', message };
  return { status: 'completed', ...(message ? { message } : {}) };
}

function normalizeLegacyAgentStatus(value: unknown): CodexSubagentState | null {
  if (typeof value === 'string') {
    const status = normalizeStatusName(value);
    return status ? { status } : null;
  }
  const raw = asRecord(value);
  for (const [name, message] of Object.entries(raw)) {
    const status = normalizeStatusName(name);
    if (!status) continue;
    return {
      status,
      ...(typeof message === 'string' && message ? { message } : {}),
    };
  }
  return null;
}

function normalizeStatusName(value: string): CodexSubagentStatus | null {
  switch (value) {
    case 'pending_init': return 'pendingInit';
    case 'running': return 'running';
    case 'interrupted': return 'interrupted';
    case 'completed': return 'completed';
    case 'errored':
    case 'failed': return 'errored';
    case 'shutdown': return 'shutdown';
    case 'not_found': return 'notFound';
    default: return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
