import type { TerminalAuthority } from '@garcon/server-agent-interface';
import {
  parseTerminalCreateRequest, parseTerminalRenameRequest, parseTerminalTerminateRequest,
  parseTerminalStreamClientMessage, parseTerminalStreamServerMessage,
  type TerminalCreateRequest, type TerminalCreateResponse, type TerminalListResponse,
  type TerminalRenameRequest, type TerminalRenameResponse, type TerminalTerminateRequest,
  type TerminalTerminateResponse, type TerminalStreamClientMessage, type TerminalStreamServerMessage,
} from '../../../common/terminal.js';
import { TerminalError } from '../../../common/terminal-error.js';
import { TERMINAL_CREATOR_V1, type EventCreator } from '@garcon/common/executor-contracts';
import type { ContractDefinition } from '@garcon/common/protocol-contracts';
import type { RpcContractRef } from './rpc-protocol.js';

type Call<Q, R> = { readonly request: Q; readonly result: R };
type Authenticated<T> = T & { readonly authority: TerminalAuthority };
type Stream<K extends TerminalStreamClientMessage['type']> = Extract<TerminalStreamClientMessage, { type: K }> & { attachmentId: string };

export interface TerminalRpcMethods {
  'terminals.list': Call<Authenticated<{}>, TerminalListResponse>;
  'terminals.create': Call<Authenticated<TerminalCreateRequest>, TerminalCreateResponse>;
  'terminals.rename': Call<Authenticated<TerminalRenameRequest>, TerminalRenameResponse>;
  'terminals.terminate': Call<Authenticated<TerminalTerminateRequest>, TerminalTerminateResponse>;
  'terminals.attach': Call<Authenticated<Stream<'terminal-attach'>>, void>;
  'terminals.input': Call<Authenticated<Stream<'terminal-input'>>, void>;
  'terminals.resize': Call<Authenticated<Stream<'terminal-resize'>>, void>;
  'terminals.detach': Call<Authenticated<Stream<'terminal-detach'>>, void>;
}

export type TerminalRpcRequest = { [K in keyof TerminalRpcMethods]: {
  method: K; version: 1; request: TerminalRpcMethods[K]['request'];
} }[keyof TerminalRpcMethods];

export interface TerminalCreator extends EventCreator {
  readonly contract: RpcContractRef<'terminals.attach'>;
  readonly detach: RpcContractRef<'terminals.detach'>;
  readonly codecs: Readonly<Record<string, ContractDefinition & { decode(value: unknown): TerminalStreamServerMessage }>>;
}

export const TERMINAL_ATTACHMENT_CODEC_V1: TerminalCreator = Object.freeze({ ...TERMINAL_CREATOR_V1,
  codecs: Object.freeze(Object.fromEntries(Object.entries(TERMINAL_CREATOR_V1.codecs).map(([kind, definition]) => [kind,
    Object.freeze({ ...definition, decode(value: unknown) {
      const message = parseTerminalStreamServerMessage(value);
      if (!message || message.type !== kind) throw invalidTerminalRequest();
      return message;
    } }),
  ]))),
});

export interface TerminalNotification {
  readonly type: 'terminal';
  readonly attachmentId: string;
  readonly message: TerminalStreamServerMessage;
}

export function validateTerminalRpc(call: TerminalRpcRequest): void {
  const input = call.request;
  const authority = input?.authority;
  if (!authority || typeof authority.key !== 'string' || !authority.key || authority.key.length > 256
    || (authority.expiresAtMs !== null && (!Number.isSafeInteger(authority.expiresAtMs) || authority.expiresAtMs <= 0))) {
    throw invalidTerminalRequest();
  }
  switch (call.method) {
    case 'terminals.list':
      return;
    case 'terminals.create':
      if (!parseTerminalCreateRequest(input)) throw invalidTerminalRequest();
      return;
    case 'terminals.rename':
      if (!parseTerminalRenameRequest(input)) throw invalidTerminalRequest();
      return;
    case 'terminals.terminate':
      if (!parseTerminalTerminateRequest(input)) throw invalidTerminalRequest();
      return;
    default: {
      const message = parseTerminalStreamClientMessage(input);
      if (!message?.attachmentId) throw invalidTerminalRequest();
      const expectedType = `terminal-${call.method.slice('terminals.'.length)}`;
      if (message.type !== expectedType) throw invalidTerminalRequest();
    }
  }
}

export function parseTerminalNotification(value: TerminalNotification, creator: TerminalCreator): TerminalNotification {
  const kind = value.message?.type;
  if (!Object.hasOwn(creator.codecs, kind)) throw invalidTerminalRequest();
  const message = creator.codecs[kind]!.decode(value.message);
  if (typeof value.attachmentId !== 'string' || !value.attachmentId || value.attachmentId.length > 256) throw invalidTerminalRequest();
  return { type: 'terminal', attachmentId: value.attachmentId, message };
}

function invalidTerminalRequest(): TerminalError {
  return new TerminalError('terminal-validation', 'Invalid terminal RPC request.');
}
