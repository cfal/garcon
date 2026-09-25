import type {
  TerminalCreateRequest, TerminalCreateResponse, TerminalListResponse,
  TerminalRenameResponse, TerminalTerminateResponse, TerminalStreamClientMessage,
  TerminalStreamServerMessage,
} from '@garcon/common/terminal';
import type { ExecutorCallOptions } from './resources.js';

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
  list(authority: TerminalAuthority, options?: ExecutorCallOptions): Promise<TerminalListResponse>;
  create(authority: TerminalAuthority, request: TerminalCreateRequest, options?: ExecutorCallOptions): Promise<TerminalCreateResponse>;
  rename(authority: TerminalAuthority, terminalId: string, title: string | null, options?: ExecutorCallOptions): Promise<TerminalRenameResponse>;
  terminate(authority: TerminalAuthority, terminalId: string, requestId: string, options?: ExecutorCallOptions): Promise<TerminalTerminateResponse>;
  attach(authority: TerminalAuthority, peer: TerminalPeer, request: Extract<TerminalStreamClientMessage, { type: 'terminal-attach' }>): Promise<void>;
  input(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, data: string): Promise<void>;
  resize(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, cols: number, rows: number): Promise<void>;
  detachPeer(authority: TerminalAuthority, peer: TerminalPeer): void;
  disconnect(): void;
}
