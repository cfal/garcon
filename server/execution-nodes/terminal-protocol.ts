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
    || (authority.expiresAtMs !== null && (!Number.isSafeInteger(authority.expiresAtMs) || authority.expiresAtMs <= 0))) throw invalidTerminalRequest();
  if (call.method === 'terminals.list') return;
  const valid = call.method === 'terminals.create' ? parseTerminalCreateRequest(input)
    : call.method === 'terminals.rename' ? parseTerminalRenameRequest(input)
    : call.method === 'terminals.terminate' ? parseTerminalTerminateRequest(input)
    : parseTerminalStreamClientMessage(input);
  if (!valid) throw invalidTerminalRequest();
  if ('type' in valid && (!('attachmentId' in valid) || !valid.attachmentId
    || valid.type !== `terminal-${call.method === 'terminals.detach' ? 'detach' : call.method.slice(10)}`)) throw invalidTerminalRequest();
}

export function parseTerminalNotification(value: TerminalNotification): TerminalNotification {
  const message = parseTerminalStreamServerMessage(value.message);
  if (typeof value.attachmentId !== 'string' || !value.attachmentId || value.attachmentId.length > 256 || !message) throw invalidTerminalRequest();
  return { type: 'terminal', attachmentId: value.attachmentId, message };
}

export function invalidTerminalRequest(): TerminalError {
  return new TerminalError('terminal-validation', 'Invalid terminal RPC request.');
}
