import {
  CodexSubagentToolUseMessage,
  codexSubagentSourceFingerprint,
  type CodexSubagentState,
  type CodexSubagentStatus,
} from '../../../common/chat-types.js';

const FINAL_ANSWER_PATTERN = /^Message Type: FINAL_ANSWER\r?\nTask name: ([^\r\n]+)\r?\nSender: ([^\r\n]+)\r?\nPayload:(?:\r?\n([\s\S]*))?$/;
const SUBAGENT_NOTIFICATION_PATTERN = /^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/;
const AGENT_NAME_PATTERN = /^[a-z0-9_]+$/;
const AGENT_ERROR_PREFIX = 'Agent errored: ';
const AGENT_ERROR_SUFFIX = "\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.";

export function convertCodexInterAgentLifecycle(
  timestamp: string,
  toolId: string,
  author: unknown,
  recipient: unknown,
  content: string,
): CodexSubagentToolUseMessage | null {
  if (
    typeof author !== 'string'
    || typeof recipient !== 'string'
    || !isAgentPath(author)
    || !isAgentPath(recipient)
  ) return null;

  const finalAnswer = parseFinalAnswer(content);
  if (
    !finalAnswer
    || finalAnswer.taskName !== recipient
    || finalAnswer.sender !== author
    || immediateParentPath(author) !== recipient
  ) return null;

  return lifecycleMessage(
    timestamp,
    toolId,
    author,
    stateForFinalAnswer(finalAnswer.payload),
    'structured',
    content,
  );
}

function immediateParentPath(agentPath: string): string | null {
  const separator = agentPath.lastIndexOf('/');
  return separator > 0 ? agentPath.slice(0, separator) : null;
}

function isAgentPath(value: string): boolean {
  if (value === '/root' || value === '/morpheus') return true;
  if (!value.startsWith('/root/')) return false;
  return value.slice('/root/'.length).split('/').every((segment) => (
    segment !== 'root' && AGENT_NAME_PATTERN.test(segment)
  ));
}

export function convertCodexSubagentLifecycleText(
  timestamp: string,
  toolId: string,
  text: string,
): CodexSubagentToolUseMessage | null {
  const finalAnswer = parseFinalAnswer(text);
  if (finalAnswer) {
    const state = stateForFinalAnswer(finalAnswer.payload);
    return lifecycleMessage(timestamp, toolId, finalAnswer.sender, state, 'legacy', text);
  }

  const notification = SUBAGENT_NOTIFICATION_PATTERN.exec(text.trim());
  if (!notification) return null;
  try {
    const payload = asRecord(JSON.parse(notification[1]));
    const target = stringValue(payload.agent_path) ?? stringValue(payload.agent_id);
    const state = normalizeLegacyAgentStatus(payload.status);
    return target && state ? lifecycleMessage(timestamp, toolId, target, state, 'legacy', text) : null;
  } catch {
    return null;
  }
}

function parseFinalAnswer(text: string): {
  taskName: string;
  sender: string;
  payload: string;
} | null {
  const match = FINAL_ANSWER_PATTERN.exec(text.trim());
  if (!match) return null;
  return {
    taskName: match[1].trim(),
    sender: match[2].trim(),
    payload: match[3] ?? '',
  };
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
    lifecycleSource: 'structured',
  });
}

function lifecycleMessage(
  timestamp: string,
  toolId: string,
  target: string,
  state: CodexSubagentState,
  source: 'structured' | 'legacy',
  sourceContent: string,
): CodexSubagentToolUseMessage {
  return new CodexSubagentToolUseMessage(timestamp, toolId, 'agent_status', {
    target,
    agentStates: { [target]: state },
    lifecycleSource: source,
    sourceFingerprint: codexSubagentSourceFingerprint(sourceContent),
  });
}

function stateForFinalAnswer(payload: string): CodexSubagentState {
  const message = payload.trim();
  if (message.startsWith(AGENT_ERROR_PREFIX) && message.endsWith(AGENT_ERROR_SUFFIX)) {
    return { status: 'errored', message };
  }
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
