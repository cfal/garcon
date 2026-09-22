import type { TerminalAuthority } from '@garcon/server-agent-interface';
import {
  parseTerminalCreateRequest, parseTerminalRenameRequest, parseTerminalTerminateRequest,
  parseTerminalStreamClientMessage, parseTerminalStreamServerMessage,
  type TerminalCreateRequest, type TerminalCreateResponse, type TerminalListResponse,
  type TerminalRenameRequest, type TerminalRenameResponse, type TerminalTerminateRequest,
  type TerminalTerminateResponse, type TerminalStreamClientMessage, type TerminalStreamServerMessage,
} from '../../common/terminal.js';
import { TerminalError } from '../../common/terminal-error.js';

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
  method: K; request: TerminalRpcMethods[K]['request'];
} }[keyof TerminalRpcMethods];

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

export function parseTerminalNotification(value: TerminalNotification): TerminalNotification {
  const message = parseTerminalStreamServerMessage(value.message);
  if (typeof value.attachmentId !== 'string' || !value.attachmentId || value.attachmentId.length > 256 || !message) throw invalidTerminalRequest();
  return { type: 'terminal', attachmentId: value.attachmentId, message };
}

export function invalidTerminalRequest(): TerminalError {
  return new TerminalError('terminal-validation', 'Invalid terminal RPC request.');
}
