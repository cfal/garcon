import { parseChatId, type ChatId } from './chat-id.js';
import { isPermissionMode, type PermissionMode } from './chat-modes.js';

export const GARCON_START_AGENT_PREFIX = '<garcon-start-agent';
export const GARCON_START_AGENT_OPEN = '<garcon-start-agent>';
export const GARCON_START_AGENT_CLOSE = '</garcon-start-agent>';
export const SUB_AGENT_START_NOTICE_TITLE = 'Sub-agent start';
export const MALFORMED_SUB_AGENT_START_CONTENT =
  'Garcon could not parse a sub-agent start command.';
export const MAX_GARCON_CREATE_CHAT_PARAMS = 16;
export const GARCON_START_PROMPT_MAX_BYTES = 48 * 1024;
export const GARCON_CREATE_CHAT_MODEL_MAX_BYTES = 256;
export const GARCON_CREATE_CHAT_PROJECT_PATH_MAX_BYTES = 4 * 1024;
export const GARCON_START_AGENT_PAYLOAD_MAX_BYTES = 384 * 1024;

export const GARCON_CREATE_CHAT_RESULT_MESSAGES = [
  'created',
  'disabled',
  'unknown-agent',
  'provider-not-supported',
  'unknown-provider',
  'unknown-endpoint',
  'incompatible-endpoint',
  'ambiguous-model',
  'unknown-model',
  'unsupported-reasoning-effort',
  'permission-override-required',
  'project-path-override-disabled',
  'permission-override-disabled',
  'unknown-project-path',
  'unsupported-permission-mode',
  'session-limit',
  'server-shutting-down',
  'chat-id-collision',
  'start-failed',
] as const;

const CREATE_CHAT_RESULT_SUCCESS = /^<garcon-create-chat-result ref="([^"]*)" error="false" msg="created" chat-id="([^"]*)" \/>$/;
const CREATE_CHAT_RESULT_FAILURE = /^<garcon-create-chat-result ref="([^"]*)" error="true" msg="([^"]*)" \/>$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_ID = /^[a-z][a-z0-9_-]{1,63}$/;
const REASONING_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const START_AGENT_PAYLOAD_KEYS = ['prompt', 'params'] as const;
const CREATE_CHAT_PARAM_KEYS = [
  'ref',
  'agent',
  'provider',
  'endpoint',
  'model',
  'reasoningEffort',
  'projectPath',
  'permissions',
] as const;
const utf8Encoder = new TextEncoder();
const createChatFailureMessages = new Set<string>(
  GARCON_CREATE_CHAT_RESULT_MESSAGES.slice(1),
);

export type GarconCreateChatResultMessage =
  typeof GARCON_CREATE_CHAT_RESULT_MESSAGES[number];
export type GarconCreateChatFailureMessage = Exclude<
  GarconCreateChatResultMessage,
  'created'
>;

export interface GarconCreateChatParams {
  readonly ref: string;
  readonly agentId: string;
  readonly providerId: string | null;
  readonly endpointId: string | null;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly projectPath: string | null;
  readonly permissionMode: PermissionMode | null;
}

export interface GarconStartAgentCommand {
  readonly type: 'start-agent';
  readonly prompt: string;
  readonly params: readonly GarconCreateChatParams[];
}

export type GarconCreateChatResult =
  | {
      readonly ref: string;
      readonly error: false;
      readonly msg: 'created';
      readonly chatId: ChatId;
    }
  | {
      readonly ref: string;
      readonly error: true;
      readonly msg: GarconCreateChatFailureMessage;
    };

export type GarconStartAgentParseResult =
  | {
      readonly kind: 'valid';
      readonly command: GarconStartAgentCommand;
      readonly end: number;
    }
  | {
      readonly kind: 'malformed';
      readonly nextCandidateStart: number;
    };

interface ContentLine {
  readonly start: number;
  readonly end: number;
  readonly nextStart: number;
  readonly hasLineBreak: boolean;
}

export function parseGarconStartAgent(
  content: string,
  start: number,
  end: number,
): GarconStartAgentParseResult {
  const parsed = parseStartAgentEnvelope(content, start, end);
  if (parsed.kind === 'malformed') return parsed;

  const command = parseStartAgentPayload(parsed.value);
  return command
    ? { kind: 'valid', command, end: parsed.end }
    : { kind: 'malformed', nextCandidateStart: parsed.end };
}

export function findGarconStartAgentCloser(
  content: string,
  searchStart: number,
  end: number,
): { readonly start: number; readonly end: number } | null {
  let cursor = searchStart;
  while (cursor < end) {
    const line = contentLine(content, cursor, end);
    if (lineEquals(content, line, GARCON_START_AGENT_CLOSE)) {
      return { start: line.start, end: line.end };
    }
    if (!line.hasLineBreak) return null;
    cursor = line.nextStart;
  }
  return null;
}

export function garconCreateChatResultsContent(
  results: readonly GarconCreateChatResult[],
): string {
  assertCreateChatResultBatch(results);
  return results.map((result) => {
    if (result.error) {
      return `<garcon-create-chat-result ref="${result.ref}" error="true" msg="${result.msg}" />`;
    }
    return `<garcon-create-chat-result ref="${result.ref}" error="false" msg="created" chat-id="${result.chatId}" />`;
  }).join('\n');
}

export function parseGarconCreateChatResults(
  content: string,
): readonly GarconCreateChatResult[] | null {
  const lines = content.split('\n');
  if (lines.length > MAX_GARCON_CREATE_CHAT_PARAMS) return null;

  const results: GarconCreateChatResult[] = [];
  const refs = new Set<string>();
  for (const line of lines) {
    const result = parseCreateChatResultLine(line);
    if (!result || refs.has(result.ref)) return null;
    refs.add(result.ref);
    results.push(result);
  }
  return results;
}

export function isGarconCreateChatResult(
  value: unknown,
): value is GarconCreateChatResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.ref !== 'string' || !CANONICAL_UUID.test(candidate.ref)) return false;
  if (candidate.error === false) {
    if (candidate.msg !== 'created' || typeof candidate.chatId !== 'string') return false;
    try {
      parseChatId(candidate.chatId);
      return true;
    } catch {
      return false;
    }
  }
  return candidate.error === true
    && isGarconCreateChatFailureMessage(candidate.msg)
    && candidate.chatId === undefined;
}

function parseStartAgentPayload(value: unknown): GarconStartAgentCommand | null {
  if (
    !isJsonObject(value)
    || !hasOnlyJsonKeys(value, START_AGENT_PAYLOAD_KEYS)
    || !Object.hasOwn(value, 'prompt')
    || !Object.hasOwn(value, 'params')
    || typeof value.prompt !== 'string'
    || !isValidStartPrompt(value.prompt)
    || !Array.isArray(value.params)
    || value.params.length < 1
    || value.params.length > MAX_GARCON_CREATE_CHAT_PARAMS
  ) {
    return null;
  }

  const params: GarconCreateChatParams[] = [];
  const refs = new Set<string>();
  for (const candidate of value.params) {
    const parsed = parseCreateChatParams(candidate);
    if (!parsed || refs.has(parsed.ref)) return null;
    refs.add(parsed.ref);
    params.push(parsed);
  }
  return { type: 'start-agent', prompt: value.prompt, params };
}

function parseCreateChatParams(value: unknown): GarconCreateChatParams | null {
  if (
    !isJsonObject(value)
    || !hasOnlyJsonKeys(value, CREATE_CHAT_PARAM_KEYS)
    || !Object.hasOwn(value, 'ref')
    || !Object.hasOwn(value, 'agent')
    || !Object.hasOwn(value, 'model')
  ) {
    return null;
  }

  const ref = value.ref;
  const agentId = value.agent;
  const providerId = value.provider;
  const endpointId = value.endpoint;
  const model = value.model;
  const reasoningEffort = value.reasoningEffort;
  const projectPath = value.projectPath;
  const permissionMode = value.permissions;
  if (
    typeof ref !== 'string'
    || !CANONICAL_UUID.test(ref)
    || typeof agentId !== 'string'
    || !SAFE_ID.test(agentId)
    || (providerId !== undefined && (
      typeof providerId !== 'string' || !SAFE_ID.test(providerId)
    ))
    || (endpointId !== undefined && (
      providerId === undefined
      || typeof endpointId !== 'string'
      || !SAFE_ID.test(endpointId)
    ))
    || typeof model !== 'string'
    || !isValidCreateChatModel(model)
    || (reasoningEffort !== undefined && (
      typeof reasoningEffort !== 'string' || !REASONING_EFFORT.test(reasoningEffort)
    ))
    || (projectPath !== undefined && (
      typeof projectPath !== 'string' || !isValidCreateChatProjectPath(projectPath)
    ))
    || (permissionMode !== undefined && !isPermissionMode(permissionMode))
  ) {
    return null;
  }
  return {
    ref,
    agentId,
    providerId: typeof providerId === 'string' ? providerId : null,
    endpointId: typeof endpointId === 'string' ? endpointId : null,
    model,
    reasoningEffort: typeof reasoningEffort === 'string' ? reasoningEffort : null,
    projectPath: typeof projectPath === 'string' ? projectPath : null,
    permissionMode: isPermissionMode(permissionMode) ? permissionMode : null,
  };
}

function parseStartAgentEnvelope(
  content: string,
  start: number,
  end: number,
):
  | { readonly kind: 'valid'; readonly value: unknown; readonly end: number }
  | { readonly kind: 'malformed'; readonly nextCandidateStart: number } {
  const openLine = contentLine(content, start, end);
  if (!lineEquals(content, openLine, GARCON_START_AGENT_OPEN)) {
    return { kind: 'malformed', nextCandidateStart: openLine.nextStart };
  }
  if (!openLine.hasLineBreak) {
    return { kind: 'malformed', nextCandidateStart: end };
  }

  const closer = findGarconStartAgentCloser(content, openLine.nextStart, end);
  if (!closer) return { kind: 'malformed', nextCandidateStart: end };

  const value = parseBoundedStartAgentJson(
    content.slice(openLine.nextStart, closer.start),
  );
  return value.ok
    ? { kind: 'valid', value: value.value, end: closer.end }
    : { kind: 'malformed', nextCandidateStart: closer.end };
}

function parseBoundedStartAgentJson(payload: string):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false } {
  if (
    payload.length > GARCON_START_AGENT_PAYLOAD_MAX_BYTES
    || utf8Encoder.encode(payload).byteLength > GARCON_START_AGENT_PAYLOAD_MAX_BYTES
  ) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(payload) };
  } catch {
    return { ok: false };
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyJsonKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseCreateChatResultLine(line: string): GarconCreateChatResult | null {
  const success = CREATE_CHAT_RESULT_SUCCESS.exec(line);
  if (success) {
    if (!CANONICAL_UUID.test(success[1])) return null;
    try {
      return {
        ref: success[1],
        error: false,
        msg: 'created',
        chatId: parseChatId(success[2]),
      };
    } catch {
      return null;
    }
  }

  const failure = CREATE_CHAT_RESULT_FAILURE.exec(line);
  const message = failure?.[2];
  if (
    !failure
    || !CANONICAL_UUID.test(failure[1])
    || !isGarconCreateChatFailureMessage(message)
  ) {
    return null;
  }
  return {
    ref: failure[1],
    error: true,
    msg: message,
  };
}

function isGarconCreateChatFailureMessage(
  value: unknown,
): value is GarconCreateChatFailureMessage {
  return typeof value === 'string' && createChatFailureMessages.has(value);
}

function assertCreateChatResultBatch(results: readonly GarconCreateChatResult[]): void {
  if (results.length < 1 || results.length > MAX_GARCON_CREATE_CHAT_PARAMS) {
    throw new RangeError(`Expected 1-${MAX_GARCON_CREATE_CHAT_PARAMS} create-chat results`);
  }
  const refs = new Set<string>();
  for (const result of results) {
    if (!CANONICAL_UUID.test(result.ref) || refs.has(result.ref)) {
      throw new TypeError('Create-chat result refs must be unique canonical UUIDs');
    }
    refs.add(result.ref);
    if (result.error) {
      if (!createChatFailureMessages.has(result.msg)) {
        throw new TypeError('Create-chat failure result has an invalid message');
      }
      continue;
    }
    parseChatId(result.chatId);
  }
}

function isValidStartPrompt(value: string): boolean {
  return value.trim().length > 0
    && value.isWellFormed()
    && utf8Encoder.encode(value).byteLength <= GARCON_START_PROMPT_MAX_BYTES;
}

function isValidCreateChatModel(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0
    && trimmed === value
    && value.isWellFormed()
    && !/[\r\n]/.test(value)
    && utf8Encoder.encode(value).byteLength <= GARCON_CREATE_CHAT_MODEL_MAX_BYTES;
}

function isValidCreateChatProjectPath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0
    && trimmed === value
    && value.isWellFormed()
    && !/[\r\n\0]/.test(value)
    && utf8Encoder.encode(value).byteLength <= GARCON_CREATE_CHAT_PROJECT_PATH_MAX_BYTES;
}

function contentLine(content: string, start: number, end: number): ContentLine {
  const newline = content.indexOf('\n', start);
  if (newline < 0 || newline >= end) {
    return { start, end, nextStart: end, hasLineBreak: false };
  }
  const lineEnd = newline > start && content[newline - 1] === '\r'
    ? newline - 1
    : newline;
  return {
    start,
    end: lineEnd,
    nextStart: newline + 1,
    hasLineBreak: true,
  };
}

function lineEquals(content: string, line: ContentLine, expected: string): boolean {
  return line.end - line.start === expected.length
    && content.startsWith(expected, line.start);
}
