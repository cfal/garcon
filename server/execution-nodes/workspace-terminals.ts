import type {
  TerminalCreateRequest,
  TerminalCreateResponse,
  TerminalErrorCode,
  TerminalMetadata,
  TerminalRenameResponse,
  TerminalStreamClientMessage,
  TerminalStreamServerMessage,
  TerminalTerminateResponse,
} from '../../common/terminal.js';

export interface TerminalPrincipal {
  readonly key: string;
  readonly expiresAtMs: number | null;
}

/** Carries process-local output and connection lifetime, not a wire request. */
export interface TerminalStreamPeer {
  readonly connectionId: string;
  readonly signal: AbortSignal;
  sendTerminalMessage(message: TerminalStreamServerMessage): void;
}

export class WorkspaceTerminalError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceTerminalError';
  }
}

export interface WorkspaceTerminalService {
  list(principal: TerminalPrincipal): TerminalMetadata[];
  create(
    principal: TerminalPrincipal,
    request: TerminalCreateRequest,
  ): Promise<TerminalCreateResponse>;
  rename(
    principal: TerminalPrincipal,
    terminalId: string,
    title: string | null,
  ): TerminalRenameResponse;
  terminate(
    principal: TerminalPrincipal,
    terminalId: string,
    requestId: string,
  ): Promise<TerminalTerminateResponse>;
  /** Linearizes local attachment controls and queues PTY effects before returning. Remote dispatch is a separate contract. */
  attach(
    principal: TerminalPrincipal,
    peer: TerminalStreamPeer,
    request: Extract<TerminalStreamClientMessage, { type: 'terminal-attach' }>,
  ): void;
  input(
    principal: TerminalPrincipal,
    peer: TerminalStreamPeer,
    terminalId: string,
    data: string,
  ): void;
  resize(
    principal: TerminalPrincipal,
    peer: TerminalStreamPeer,
    terminalId: string,
    cols: number,
    rows: number,
  ): void;
  detachPeer(principal: TerminalPrincipal, peer: TerminalStreamPeer): void;
  detachTerminal(principal: TerminalPrincipal, peer: TerminalStreamPeer, terminalId: string): void;
  shutdown(): Promise<void>;
}
