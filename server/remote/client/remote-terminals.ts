import { AgentCallError, type ExecutionTerminalService, type TerminalAuthority, type TerminalPeer, type ExecutorCallOptions } from '@garcon/server-agent-interface';
import { TerminalError } from '../../../common/terminal-error.js';
import { parseTerminalReference } from '../../../common/terminal-identity.js';
import { parseTerminalListResponse, parseTerminalCreateResponse, parseTerminalRenameResponse, parseTerminalTerminateResponse,
  terminalIdForMessage, type TerminalCreateRequest, type TerminalStreamClientMessage } from '../../../common/terminal.js';
import type { RemoteSessions } from './executor-client.js';
import type { ExecutorRpc } from '../transport/rpc.js';
import type { TerminalNotification } from '../transport/terminal-protocol.js';

interface Attachment {
  authority: TerminalAuthority;
  peer: TerminalPeer;
  terminalId: string;
  // Null while the attachment waits for a reconnecting executor.
  rpc: ExecutorRpc | null;
}

export class RemoteTerminalService implements ExecutionTerminalService {
  readonly #attachments = new Map<string, Attachment>();
  constructor(private readonly sessions: RemoteSessions) {}

  async list(authority: TerminalAuthority, options?: ExecutorCallOptions) {
    const { backing, timeoutMs } = await this.sessions.acquire('primary', options);
    const response = parseTerminalListResponse(await backing.rpc.call('', 'terminals.list', { authority }, { ...options, timeoutMs }));
    if (!response?.terminalRuntimeId || !response.attachmentEpoch || response.terminals.some(terminal => {
      const ref = parseTerminalReference(terminal.terminalId);
      return !ref || ref.executorId !== backing.info.executorId || ref.terminalRuntimeId !== response.terminalRuntimeId;
    })) throw new TerminalError('terminal-internal', 'Invalid terminal inventory.', 502);
    return response;
  }
  async create(authority: TerminalAuthority, request: TerminalCreateRequest, options?: ExecutorCallOptions) {
    const { backing, timeoutMs } = await this.sessions.acquire('primary', options);
    const result = parseTerminalCreateResponse(await backing.rpc.call('', 'terminals.create', { ...request, authority }, { ...options, timeoutMs }));
    const ref = result && parseTerminalReference(result.terminal.terminalId);
    if (!result || !ref || ref.terminalRuntimeId !== request.expectedTerminalRuntimeId || ref.executorId !== backing.info.executorId) throw new TerminalError('terminal-outcome-unknown', 'Invalid terminal create response. Refresh the terminal list.', 502);
    return result;
  }
  async rename(authority: TerminalAuthority, terminalId: string, title: string | null, options?: ExecutorCallOptions) {
    const result = parseTerminalRenameResponse(await this.sessions.call('', 'terminals.rename', { authority, terminalId, title }, options));
    if (!result || result.terminalId !== terminalId) throw new TerminalError('terminal-outcome-unknown', 'Invalid terminal rename response.', 502);
    return result;
  }
  async terminate(authority: TerminalAuthority, terminalId: string, requestId: string, options?: ExecutorCallOptions) {
    const result = parseTerminalTerminateResponse(await this.sessions.call('', 'terminals.terminate', { authority, terminalId, requestId }, options));
    if (!result || result.terminalId !== terminalId) throw new TerminalError('terminal-outcome-unknown', 'Invalid terminal terminate response.', 502);
    return result;
  }
  async attach(authority: TerminalAuthority, peer: TerminalPeer, request: Extract<TerminalStreamClientMessage, { type: 'terminal-attach' }>) {
    this.sessions.latest();
    if (this.#attachments.size >= 256) throw new TerminalError('terminal-backpressure', 'Terminal attachment budget exhausted.', 429);
    const attachmentId = crypto.randomUUID();
    const attachment: Attachment = { authority, peer, terminalId: request.terminalId, rpc: null };
    // Registered before any wait so that a peer detaching meanwhile is never attached.
    this.#attachments.set(attachmentId, attachment);
    try {
      const { backing, timeoutMs } = await this.sessions.acquire('primary');
      if (this.#attachments.get(attachmentId) !== attachment) return;
      attachment.rpc = backing.rpc;
      await backing.rpc.call('', 'terminals.attach', { ...request, authority, attachmentId }, { timeoutMs });
    } catch (error) {
      if (!(error instanceof TerminalError && error.code === 'terminal-takeover-required')) this.#detach(attachmentId);
      throw error;
    }
  }
  async input(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, data: string) {
    const [attachmentId, rpc] = this.#find(authority, peer, terminalId);
    await rpc.call('', 'terminals.input', { authority, attachmentId, terminalId, type: 'terminal-input', data });
  }
  async resize(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, cols: number, rows: number) {
    const [attachmentId, rpc] = this.#find(authority, peer, terminalId);
    await rpc.call('', 'terminals.resize', { authority, attachmentId, terminalId, type: 'terminal-resize', cols, rows });
  }
  detachPeer(authority: TerminalAuthority, peer: TerminalPeer): void {
    for (const [id, attachment] of this.#attachments) {
      if (attachment.peer === peer && attachment.authority.key === authority.key) this.#detach(id);
    }
  }
  receive(frame: TerminalNotification, rpc: ExecutorRpc): void {
    const attachment = this.#attachments.get(frame.attachmentId);
    if (!attachment || attachment.rpc !== rpc) return;
    const message = frame.message;
    const terminalId = terminalIdForMessage(message);
    if (terminalId !== attachment.terminalId) throw new Error('Terminal notification target mismatch');
    if (message.type === 'terminal-attached') attachment.peer.ownedTerminalIds.add(terminalId);
    if (message.type === 'terminal-taken-over' || message.type === 'terminal-terminated') attachment.peer.ownedTerminalIds.delete(terminalId);
    attachment.peer.sendTerminalMessage(message);
    if (message.type === 'terminal-terminated') this.#detach(frame.attachmentId);
  }
  disconnect(): void {
    for (const [id, attachment] of this.#attachments) {
      this.#attachments.delete(id);
      attachment.peer.ownedTerminalIds.delete(attachment.terminalId);
      attachment.peer.sendTerminalMessage({ type: 'terminal-error', terminalId: attachment.terminalId, code: 'terminal-unavailable', message: 'Terminal executor disconnected.' });
    }
  }
  #find(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string): [string, ExecutorRpc] {
    for (const [attachmentId, attachment] of this.#attachments) {
      if (attachment.rpc && attachment.peer === peer && attachment.terminalId === terminalId && attachment.authority.key === authority.key) {
        return [attachmentId, attachment.rpc];
      }
    }
    throw new AgentCallError('not-dispatched', 'Terminal attachment is unavailable');
  }
  #detach(id: string): void {
    const attachment = this.#attachments.get(id);
    if (!attachment) return;
    this.#attachments.delete(id);
    attachment.peer.ownedTerminalIds.delete(attachment.terminalId);
    try {
      attachment.rpc?.detachTerminal({ authority: attachment.authority, terminalId: attachment.terminalId, attachmentId: id, type: 'terminal-detach' });
    } catch { /* Transport failure retires all worker attachments. */ }
  }
}
