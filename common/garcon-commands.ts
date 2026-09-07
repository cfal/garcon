import { parseChatId, type ChatId } from './chat-id.js';
import { AssistantMessage, type ChatMessage } from './chat-types.js';
import { normalizeGarconCommandBody } from './garcon-command-text.js';

export const GARCON_GET_CHAT_ID = '<garcon-get-chat-id />';
export const GARCON_SEND_MESSAGE_PREFIX = '<garcon-send-message';
export const GARCON_SEND_MESSAGE_CLOSE = '</garcon-send-message>';
export const GARCON_MESSAGE_OPEN = '<garcon-message>';
export const GARCON_MESSAGE_CLOSE = '</garcon-message>';
export const INTER_AGENT_MESSAGE_NOTICE_TITLE = 'Inter-agent message';
export const MALFORMED_INTER_AGENT_MESSAGE_CONTENT =
  'Garcon could not parse an inter-agent message command.';
export const MAX_GARCON_MESSAGE_RECIPIENTS = 16;
export const GARCON_MESSAGE_BODY_MAX_BYTES = 60 * 1024;

const SEND_MESSAGE_OPEN = /^<garcon-send-message to="([^"]*)" hide-sender="(true|false)">$/;
const RECEIVED_MESSAGE_OPEN = /^<garcon-message from="([^"]*)">$/;
const utf8Encoder = new TextEncoder();

export type GarconEdgeCommand =
  | { readonly type: 'get-chat-id' }
  | {
      readonly type: 'send-message';
      readonly recipients: readonly ChatId[];
      readonly hideSender: boolean;
      readonly body: string;
    };

export interface GarconCommandIssue {
  readonly command: 'send-message';
  readonly reason: 'malformed';
  readonly edge: 'leading' | 'trailing';
}

export interface GarconCommandTransform {
  readonly message: AssistantMessage | null;
  readonly commands: readonly GarconEdgeCommand[];
  readonly issues: readonly GarconCommandIssue[];
}

export interface GarconReceivedMessage {
  readonly fromChatId: ChatId | null;
  readonly body: string;
}

type ParsedEdge =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'valid';
      readonly command: GarconEdgeCommand;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'malformed';
      readonly candidateStart: number;
      readonly command: GarconCommandIssue['command'];
    };

export function extractGarconCommands(
  message: ChatMessage,
): GarconCommandTransform | null {
  if (message.type !== 'assistant-message') return null;

  const content = message.content;
  let start = 0;
  let end = content.length;
  // Providers append trailing whitespace to standalone command messages, so
  // commands are recognized against the trimmed trailing edge while the
  // retained remainder keeps its original bytes.
  let parseEnd = trimEndIndex(content, start, end);
  const leading: GarconEdgeCommand[] = [];
  const trailing: GarconEdgeCommand[] = [];
  const issues: GarconCommandIssue[] = [];
  const malformedStarts = new Set<number>();

  while (start < end) {
    const parsed = parseLeadingCommand(content, start, parseEnd);
    if (parsed.kind === 'none') break;
    if (parsed.kind === 'malformed') {
      recordIssue(
        issues,
        malformedStarts,
        parsed.command,
        parsed.candidateStart,
        'leading',
      );
      break;
    }
    leading.push(parsed.command);
    start = trimStartIndex(content, parsed.end, parseEnd);
  }

  while (start < end) {
    const parsed = parseTrailingCommand(content, start, parseEnd);
    if (parsed.kind === 'none') break;
    if (parsed.kind === 'malformed') {
      recordIssue(
        issues,
        malformedStarts,
        parsed.command,
        parsed.candidateStart,
        'trailing',
      );
      break;
    }
    trailing.push(parsed.command);
    end = trimEndIndex(content, start, parsed.start);
    parseEnd = end;
  }

  if (leading.length === 0 && trailing.length === 0 && issues.length === 0) {
    return null;
  }

  const remainder = content.slice(start, end);
  return {
    message: remainder.trim()
      ? new AssistantMessage(message.timestamp, remainder)
      : null,
    commands: [...leading, ...trailing.reverse()],
    issues,
  };
}

export function garconMessageContent(fromChatId: ChatId | null, body: string): string {
  const open = fromChatId === null
    ? GARCON_MESSAGE_OPEN
    : `<garcon-message from="${fromChatId}">`;
  return `${open}\n${body}\n${GARCON_MESSAGE_CLOSE}`;
}

export function parseGarconMessage(content: string): GarconReceivedMessage | null {
  const value = content.trim();
  if (!value.endsWith(GARCON_MESSAGE_CLOSE)) return null;

  const openerEnd = value.indexOf('>');
  if (openerEnd < 0) return null;
  const opener = value.slice(0, openerEnd + 1);
  let fromChatId: ChatId | null;
  if (opener === GARCON_MESSAGE_OPEN) {
    fromChatId = null;
  } else {
    const match = RECEIVED_MESSAGE_OPEN.exec(opener);
    if (!match) return null;
    try {
      fromChatId = parseChatId(match[1]);
    } catch {
      return null;
    }
  }

  const rawBody = value.slice(openerEnd + 1, -GARCON_MESSAGE_CLOSE.length);
  const body = normalizeGarconCommandBody(rawBody);
  if (!isValidBody(body)) return null;
  return { fromChatId, body };
}

function parseLeadingCommand(content: string, start: number, end: number): ParsedEdge {
  if (
    start + GARCON_GET_CHAT_ID.length <= end
    && content.startsWith(GARCON_GET_CHAT_ID, start)
  ) {
    const commandEnd = start + GARCON_GET_CHAT_ID.length;
    return {
      kind: 'valid',
      command: { type: 'get-chat-id' },
      start,
      end: commandEnd,
    };
  }
  if (!content.startsWith(GARCON_SEND_MESSAGE_PREFIX, start)) return { kind: 'none' };

  const openerEnd = content.indexOf('>', start + GARCON_SEND_MESSAGE_PREFIX.length);
  if (openerEnd < 0 || openerEnd >= end) {
    return { kind: 'malformed', command: 'send-message', candidateStart: start };
  }
  const closerStart = content.indexOf(GARCON_SEND_MESSAGE_CLOSE, openerEnd + 1);
  if (closerStart < 0 || closerStart + GARCON_SEND_MESSAGE_CLOSE.length > end) {
    return { kind: 'malformed', command: 'send-message', candidateStart: start };
  }
  const command = parseSendMessage(
    content.slice(start, openerEnd + 1),
    content.slice(openerEnd + 1, closerStart),
  );
  if (!command) {
    return { kind: 'malformed', command: 'send-message', candidateStart: start };
  }
  const commandEnd = closerStart + GARCON_SEND_MESSAGE_CLOSE.length;
  return {
    kind: 'valid',
    command,
    start,
    end: commandEnd,
  };
}

function parseTrailingCommand(content: string, start: number, end: number): ParsedEdge {
  const unclosedEnvelope = findUnclosedEnvelope(content, start, end);
  if (unclosedEnvelope) return unclosedEnvelope;

  const markerStart = end - GARCON_GET_CHAT_ID.length;
  if (
    markerStart >= start
    && isTrailingCommandBoundary(content, start, markerStart)
    && content.startsWith(GARCON_GET_CHAT_ID, markerStart)
  ) {
    return {
      kind: 'valid',
      command: { type: 'get-chat-id' },
      start: markerStart,
      end,
    };
  }

  const sendCloserStart = end - GARCON_SEND_MESSAGE_CLOSE.length;
  if (
    sendCloserStart >= start
    && content.startsWith(GARCON_SEND_MESSAGE_CLOSE, sendCloserStart)
  ) {
    const parsed = parseTrailingSendMessage(content, start, end);
    if (parsed.kind !== 'none') return parsed;
  }

  const sendCandidateStart = findBoundaryPrefix(
    content,
    start,
    start,
    end,
    GARCON_SEND_MESSAGE_PREFIX,
  );
  if (sendCandidateStart < 0) return { kind: 'none' };
  return {
    kind: 'malformed',
    command: 'send-message',
    candidateStart: sendCandidateStart,
  };
}

function findUnclosedEnvelope(
  content: string,
  start: number,
  end: number,
): Extract<ParsedEdge, { readonly kind: 'malformed' }> | null {
  let searchStart = start;
  while (searchStart < end) {
    const candidateStart = findBoundaryPrefix(
      content,
      start,
      searchStart,
      end,
      GARCON_SEND_MESSAGE_PREFIX,
    );
    if (candidateStart < 0) return null;
    const closerEnd = findSendMessageCloserEnd(content, candidateStart, end);
    if (closerEnd < 0) {
      return { kind: 'malformed', command: 'send-message', candidateStart };
    }
    searchStart = closerEnd;
  }
  return null;
}

function findSendMessageCloserEnd(content: string, start: number, end: number): number {
  const closerStart = content.indexOf(GARCON_SEND_MESSAGE_CLOSE, start);
  if (closerStart < 0) return -1;
  const closerEnd = closerStart + GARCON_SEND_MESSAGE_CLOSE.length;
  return closerEnd <= end ? closerEnd : -1;
}

function parseTrailingSendMessage(content: string, start: number, end: number): ParsedEdge {
  const firstCandidateStart = findBoundaryPrefix(
    content,
    start,
    start,
    end,
    GARCON_SEND_MESSAGE_PREFIX,
  );
  if (firstCandidateStart < 0) return { kind: 'none' };

  const closerStart = end - GARCON_SEND_MESSAGE_CLOSE.length;
  if (!content.startsWith(GARCON_SEND_MESSAGE_CLOSE, closerStart)) {
    return {
      kind: 'malformed',
      command: 'send-message',
      candidateStart: firstCandidateStart,
    };
  }

  const previousCloserStart = content.lastIndexOf(
    GARCON_SEND_MESSAGE_CLOSE,
    closerStart - 1,
  );
  const candidateStart = findBoundaryPrefix(
    content,
    start,
    previousCloserStart < start
      ? start
      : previousCloserStart + GARCON_SEND_MESSAGE_CLOSE.length,
    closerStart,
    GARCON_SEND_MESSAGE_PREFIX,
  );
  if (candidateStart < 0) {
    return {
      kind: 'malformed',
      command: 'send-message',
      candidateStart: firstCandidateStart,
    };
  }

  const openerEnd = content.indexOf('>', candidateStart + GARCON_SEND_MESSAGE_PREFIX.length);
  if (openerEnd < 0 || openerEnd >= closerStart) {
    return { kind: 'malformed', command: 'send-message', candidateStart };
  }
  const command = parseSendMessage(
    content.slice(candidateStart, openerEnd + 1),
    content.slice(openerEnd + 1, closerStart),
  );
  if (!command) {
    return { kind: 'malformed', command: 'send-message', candidateStart };
  }
  return { kind: 'valid', command, start: candidateStart, end };
}

function isTrailingCommandBoundary(content: string, start: number, commandStart: number): boolean {
  return commandStart === start || content[commandStart - 1] === '\n';
}

function findBoundaryPrefix(
  content: string,
  boundaryStart: number,
  searchStart: number,
  end: number,
  prefix: string,
): number {
  let candidateStart = content.indexOf(prefix, searchStart);
  while (candidateStart >= 0 && candidateStart < end) {
    if (
      candidateStart >= boundaryStart
      && isTrailingCommandBoundary(content, boundaryStart, candidateStart)
    ) {
      return candidateStart;
    }
    candidateStart = content.indexOf(
      prefix,
      candidateStart + prefix.length,
    );
  }
  return -1;
}

function parseSendMessage(opener: string, rawBody: string): GarconEdgeCommand | null {
  const match = SEND_MESSAGE_OPEN.exec(opener);
  if (!match) return null;

  const recipients = parseRecipients(match[1]);
  if (!recipients) return null;
  const body = normalizeGarconCommandBody(rawBody);
  if (!isValidBody(body)) return null;
  return {
    type: 'send-message',
    recipients,
    hideSender: match[2] === 'true',
    body,
  };
}

function parseRecipients(value: string): readonly ChatId[] | null {
  const recipients: ChatId[] = [];
  const seen = new Set<ChatId>();
  for (const candidate of value.split(',')) {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    let chatId: ChatId;
    try {
      chatId = parseChatId(trimmed);
    } catch {
      return null;
    }
    if (seen.has(chatId)) continue;
    seen.add(chatId);
    recipients.push(chatId);
    if (recipients.length > MAX_GARCON_MESSAGE_RECIPIENTS) return null;
  }
  return recipients.length > 0 ? recipients : null;
}

function isValidBody(value: string): boolean {
  return value.trim().length > 0
    && value.isWellFormed()
    && utf8Encoder.encode(value).byteLength <= GARCON_MESSAGE_BODY_MAX_BYTES;
}

function trimStartIndex(content: string, start: number, end: number): number {
  const trimmed = content.slice(start, end).trimStart();
  return end - trimmed.length;
}

function trimEndIndex(content: string, start: number, end: number): number {
  return start + content.slice(start, end).trimEnd().length;
}

function recordIssue(
  issues: GarconCommandIssue[],
  starts: Set<number>,
  command: GarconCommandIssue['command'],
  candidateStart: number,
  edge: GarconCommandIssue['edge'],
): void {
  if (starts.has(candidateStart)) return;
  starts.add(candidateStart);
  issues.push({ command, reason: 'malformed', edge });
}
