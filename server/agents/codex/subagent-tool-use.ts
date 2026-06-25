import {
  CODEX_SUBAGENT_ACTIONS,
  CodexSubagentToolUseMessage,
  type CodexSubagentAction,
  type CodexSubagentDetails,
  type CodexSubagentInputItem,
} from '../../../common/chat-types.js';

const CODEX_SUBAGENT_ACTION_SET = new Set<string>(CODEX_SUBAGENT_ACTIONS);
const MULTI_AGENT_V1_PREFIX = 'multi_agent_v1.';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string =>
      typeof item === 'string' && item.trim().length > 0,
  );
  return items.length > 0 ? items : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeAction(toolName: string): CodexSubagentAction | null {
  const action = toolName.startsWith(MULTI_AGENT_V1_PREFIX)
    ? toolName.slice(MULTI_AGENT_V1_PREFIX.length)
    : toolName;
  return CODEX_SUBAGENT_ACTION_SET.has(action)
    ? (action as CodexSubagentAction)
    : null;
}

function normalizeInputItems(
  value: unknown,
): CodexSubagentInputItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: CodexSubagentInputItem[] = [];
  for (const entry of value) {
    const raw = asObject(entry);
    const item: CodexSubagentInputItem = {};
    if (typeof raw.type === 'string') item.type = raw.type;
    if (typeof raw.text === 'string') item.text = raw.text;
    if (typeof raw.image_url === 'string') item.imageUrl = raw.image_url;
    if (typeof raw.imageUrl === 'string') item.imageUrl = raw.imageUrl;
    if (typeof raw.path === 'string') item.path = raw.path;
    if (typeof raw.name === 'string') item.name = raw.name;
    if (Object.keys(item).length > 0) items.push(item);
  }
  return items.length > 0 || value.length === 0 ? items : undefined;
}

function setString(
  details: CodexSubagentDetails,
  key: keyof CodexSubagentDetails,
  value: unknown,
): void {
  const stringValue = asString(value);
  if (stringValue !== undefined) {
    (details as Record<string, unknown>)[key] = stringValue;
  }
}

function setBoolean(
  details: CodexSubagentDetails,
  key: keyof CodexSubagentDetails,
  value: unknown,
): void {
  const booleanValue = asBoolean(value);
  if (booleanValue !== undefined) {
    (details as Record<string, unknown>)[key] = booleanValue;
  }
}

function normalizeDetails(
  input: Record<string, unknown>,
): CodexSubagentDetails {
  const details: CodexSubagentDetails = {};
  setString(details, 'target', input.target ?? input.id);
  const targets = asStringArray(input.targets);
  if (targets !== undefined) details.targets = targets;
  setString(details, 'message', input.message);
  setString(details, 'taskName', input.task_name ?? input.taskName);
  setString(details, 'agentType', input.agent_type ?? input.agentType);
  setString(details, 'model', input.model);
  setString(
    details,
    'reasoningEffort',
    input.reasoning_effort ?? input.reasoningEffort,
  );
  setString(details, 'serviceTier', input.service_tier ?? input.serviceTier);
  setBoolean(details, 'forkContext', input.fork_context ?? input.forkContext);
  setString(details, 'forkTurns', input.fork_turns ?? input.forkTurns);
  const timeoutMs = asNumber(input.timeout_ms ?? input.timeoutMs);
  if (timeoutMs !== undefined) details.timeoutMs = timeoutMs;
  setString(details, 'pathPrefix', input.path_prefix ?? input.pathPrefix);
  setBoolean(details, 'interrupt', input.interrupt);
  const items = normalizeInputItems(input.items);
  if (items !== undefined) details.items = items;
  return details;
}

export function convertCodexSubagentToolUse(
  timestamp: string,
  toolId: string,
  toolName: string,
  input: Record<string, unknown>,
): CodexSubagentToolUseMessage | null {
  const action = normalizeAction(toolName);
  if (!action) return null;
  return new CodexSubagentToolUseMessage(
    timestamp,
    toolId,
    action,
    normalizeDetails(input),
  );
}
