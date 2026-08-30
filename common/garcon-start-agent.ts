import { parseChatId, type ChatId } from './chat-id.js';
import { normalizeGarconCommandBody } from './garcon-command-text.js';

export const GARCON_START_AGENT_PREFIX = '<garcon-start-agent';
export const GARCON_START_AGENT_OPEN = '<garcon-start-agent>';
export const GARCON_START_AGENT_CLOSE = '</garcon-start-agent>';
export const GARCON_PROMPT_OPEN = '<garcon-prompt>';
export const GARCON_PROMPT_CLOSE = '</garcon-prompt>';
export const GARCON_CREATE_CHAT_PARAMS_PREFIX = '<garcon-create-chat-params';
export const SUB_AGENT_START_NOTICE_TITLE = 'Sub-agent start';
export const MALFORMED_SUB_AGENT_START_CONTENT =
  'Garcon could not parse a sub-agent start command.';
export const MAX_GARCON_CREATE_CHAT_PARAMS = 16;
export const GARCON_START_PROMPT_MAX_BYTES = 48 * 1024;
export const GARCON_CREATE_CHAT_MODEL_MAX_BYTES = 256;

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
  'session-limit',
  'server-shutting-down',
  'chat-id-collision',
  'start-failed',
] as const;

const CREATE_CHAT_PARAMS = /^<garcon-create-chat-params ref="([^"]*)" agent="([^"]*)"(?: provider="([^"]*)"(?: endpoint="([^"]*)")?)? model="([^"]*)"(?: reasoning-effort="([^"]*)")? \/>$/;
const CREATE_CHAT_RESULT_SUCCESS = /^<garcon-create-chat-result ref="([^"]*)" error="false" msg="created" chat-id="([^"]*)" \/>$/;
const CREATE_CHAT_RESULT_FAILURE = /^<garcon-create-chat-result ref="([^"]*)" error="true" msg="([^"]*)" \/>$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_ID = /^[a-z][a-z0-9_-]{1,63}$/;
const REASONING_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
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

interface ParsedCreateChatParamsBlock {
  readonly params: readonly GarconCreateChatParams[];
  readonly end: number;
}

export function parseGarconStartAgent(
  content: string,
  start: number,
  end: number,
): GarconStartAgentParseResult {
  const outerOpen = contentLine(content, start, end);
  if (!lineEquals(content, outerOpen, GARCON_START_AGENT_OPEN)) {
    return { kind: 'malformed', nextCandidateStart: outerOpen.nextStart };
  }
  if (!outerOpen.hasLineBreak) {
    return { kind: 'malformed', nextCandidateStart: end };
  }

  const promptOpen = contentLine(content, outerOpen.nextStart, end);
  if (!lineEquals(content, promptOpen, GARCON_PROMPT_OPEN)) {
    return { kind: 'malformed', nextCandidateStart: promptOpen.start };
  }
  if (!promptOpen.hasLineBreak) {
    return { kind: 'malformed', nextCandidateStart: end };
  }

  let promptClose: ContentLine | null = null;
  const nestedPromptOpeners: ContentLine[] = [];
  let cursor = promptOpen.nextStart;
  while (cursor < end) {
    const line = contentLine(content, cursor, end);
    if (lineEquals(content, line, GARCON_PROMPT_CLOSE)) {
      promptClose = line;
      break;
    }
    if (lineEquals(content, line, GARCON_START_AGENT_OPEN) && line.hasLineBreak) {
      const nextLine = contentLine(content, line.nextStart, end);
      if (lineEquals(content, nextLine, GARCON_PROMPT_OPEN)) {
        nestedPromptOpeners.push(nextLine);
      }
    }
    if (!line.hasLineBreak) {
      return { kind: 'malformed', nextCandidateStart: end };
    }
    cursor = line.nextStart;
  }
  if (!promptClose || !promptClose.hasLineBreak) {
    return { kind: 'malformed', nextCandidateStart: end };
  }
  if (completesNestedStartAgent(content, nestedPromptOpeners, promptClose, end)) {
    return { kind: 'malformed', nextCandidateStart: end };
  }

  const prompt = normalizeGarconCommandBody(
    content.slice(promptOpen.end, promptClose.start),
  );
  if (!isValidStartPrompt(prompt)) {
    return { kind: 'malformed', nextCandidateStart: end };
  }

  const parsedParams = parseCreateChatParamsBlock(content, promptClose.nextStart, end);
  if (!parsedParams) {
    return { kind: 'malformed', nextCandidateStart: end };
  }
  return {
    kind: 'valid',
    command: { type: 'start-agent', prompt, params: parsedParams.params },
    end: parsedParams.end,
  };
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

function completesNestedStartAgent(
  content: string,
  promptOpeners: readonly ContentLine[],
  promptClose: ContentLine,
  end: number,
): boolean {
  if (promptOpeners.length === 0) return false;
  if (!parseCreateChatParamsBlock(content, promptClose.nextStart, end)) return false;

  for (let index = promptOpeners.length - 1; index >= 0; index -= 1) {
    const prompt = normalizeGarconCommandBody(
      content.slice(promptOpeners[index].end, promptClose.start),
    );
    if (isValidStartPrompt(prompt)) return true;
  }
  return false;
}

function parseCreateChatParamsBlock(
  content: string,
  start: number,
  end: number,
): ParsedCreateChatParamsBlock | null {
  const params: GarconCreateChatParams[] = [];
  const refs = new Set<string>();
  let cursor = start;
  while (cursor < end) {
    const line = contentLine(content, cursor, end);
    if (lineEquals(content, line, GARCON_START_AGENT_CLOSE)) {
      if (params.length === 0) return null;
      return { params, end: line.end };
    }
    const parsedParams = parseCreateChatParams(content.slice(line.start, line.end));
    if (
      !parsedParams
      || refs.has(parsedParams.ref)
      || params.length === MAX_GARCON_CREATE_CHAT_PARAMS
      || !line.hasLineBreak
    ) {
      return null;
    }
    refs.add(parsedParams.ref);
    params.push(parsedParams);
    cursor = line.nextStart;
  }
  return null;
}

function parseCreateChatParams(line: string): GarconCreateChatParams | null {
  const match = CREATE_CHAT_PARAMS.exec(line);
  if (!match) return null;

  const [ref, agentId, providerId, endpointId, model, reasoningEffort] = match.slice(1);
  if (
    !CANONICAL_UUID.test(ref)
    || !SAFE_ID.test(agentId)
    || (providerId !== undefined && !SAFE_ID.test(providerId))
    || (endpointId !== undefined && !SAFE_ID.test(endpointId))
    || !isValidCreateChatModel(model)
    || (reasoningEffort !== undefined && !REASONING_EFFORT.test(reasoningEffort))
  ) {
    return null;
  }
  return {
    ref,
    agentId,
    providerId: providerId ?? null,
    endpointId: endpointId ?? null,
    model,
    reasoningEffort: reasoningEffort ?? null,
  };
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
    && !/["<>&\r\n]/.test(value)
    && utf8Encoder.encode(value).byteLength <= GARCON_CREATE_CHAT_MODEL_MAX_BYTES;
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
