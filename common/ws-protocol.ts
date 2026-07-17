import {
  parseTerminalStreamClientMessage,
  parseTerminalStreamServerMessage,
  type TerminalStreamClientMessage,
  type TerminalStreamServerMessage,
} from './terminal.js';
import {
  parseClientWsMessage,
  type ClientWsMessage,
} from './ws-requests.js';
import {
  parseServerWsMessage,
  type ServerWsMessage,
} from './ws-events.js';

export type PrimaryWsClientMessage =
  | ClientWsMessage
  | TerminalStreamClientMessage;

export type PrimaryWsServerMessage =
  | ServerWsMessage
  | TerminalStreamServerMessage;

export type TerminalStreamClientMessageType =
  TerminalStreamClientMessage['type'];

const TERMINAL_CLIENT_TYPE_RECORD = {
  'terminal-attach': true,
  'terminal-input': true,
  'terminal-resize': true,
} satisfies Record<TerminalStreamClientMessageType, true>;

export const TERMINAL_STREAM_CLIENT_MESSAGE_TYPES = Object.freeze(
  Object.keys(TERMINAL_CLIENT_TYPE_RECORD) as TerminalStreamClientMessageType[],
);

const TERMINAL_CLIENT_TYPES = new Set<TerminalStreamClientMessageType>(
  TERMINAL_STREAM_CLIENT_MESSAGE_TYPES,
);

export function isTerminalStreamClientMessageType(
  value: unknown,
): value is TerminalStreamClientMessageType {
  return typeof value === 'string'
    && TERMINAL_CLIENT_TYPES.has(value as TerminalStreamClientMessageType);
}

export function parsePrimaryWsClientMessage(
  data: Record<string, unknown>,
): PrimaryWsClientMessage | null {
  return isTerminalStreamClientMessageType(data.type)
    ? parseTerminalStreamClientMessage(data)
    : parseClientWsMessage(data);
}

export function parsePrimaryWsServerMessage(
  data: Record<string, unknown>,
): PrimaryWsServerMessage | null {
  return parseTerminalStreamServerMessage(data) ?? parseServerWsMessage(data);
}
