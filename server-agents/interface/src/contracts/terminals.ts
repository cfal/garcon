import type {
  TerminalCreateRequest, TerminalCreateResponse, TerminalListResponse,
  TerminalRenameResponse, TerminalTerminateResponse, TerminalStreamClientMessage,
  TerminalStreamServerMessage,
} from '@garcon/common/terminal';
import type { NodeCallOptions } from './resources.js';

export interface TerminalAuthority {
  readonly key: string;
  readonly expiresAtMs: number | null;
}

export interface TerminalPeer {
  readonly connectionId: string;
  readonly ownedTerminalIds: Set<string>;
  sendTerminalMessage(message: TerminalStreamServerMessage): void;
}

export interface ExecutionTerminalService {
  list(authority: TerminalAuthority, options?: NodeCallOptions): Promise<TerminalListResponse>;
  create(authority: TerminalAuthority, request: TerminalCreateRequest, options?: NodeCallOptions): Promise<TerminalCreateResponse>;
  rename(authority: TerminalAuthority, terminalId: string, title: string | null, options?: NodeCallOptions): Promise<TerminalRenameResponse>;
  terminate(authority: TerminalAuthority, terminalId: string, requestId: string, options?: NodeCallOptions): Promise<TerminalTerminateResponse>;
  attach(authority: TerminalAuthority, peer: TerminalPeer, request: Extract<TerminalStreamClientMessage, { type: 'terminal-attach' }>): Promise<void>;
  input(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, data: string): Promise<void>;
  resize(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, cols: number, rows: number): Promise<void>;
  detachPeer(authority: TerminalAuthority, peer: TerminalPeer): void;
  detachTerminal(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string): void;
}
