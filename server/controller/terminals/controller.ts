import { AgentCallError, type ExecutionRuntimeApi, type ExecutionTerminalService, type TerminalAuthority, type TerminalPeer } from '@garcon/server-agent-interface';
import type { TerminalCreateRequest, TerminalStreamClientMessage } from '../../../common/terminal.js';
import { TerminalError } from '../../../common/terminal-error.js';
import { parseTerminalReference } from '../../../common/terminal-identity.js';
import { effectiveExecutorId } from '../../../common/executors.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';

function delegatedAuthority(principal: ServerPrincipal): TerminalAuthority {
  return { key: JSON.stringify([principal.mode, principal.key]), expiresAtMs: principal.expiresAtMs };
}

interface Attachment {
  readonly id: string;
  readonly authority: TerminalAuthority;
  readonly peer: TerminalPeer;
  service: ExecutionTerminalService | null;
  retired: boolean;
}

export class TerminalController {
  readonly #attachments = new Map<TerminalPeer, Map<string, Attachment>>();
  constructor(private readonly executors: { requireExecutor(id: string): ExecutionRuntimeApi }) {}

  async list(principal: ServerPrincipal, executorId = 'local') {
    return (await this.#service(executorId)).list(delegatedAuthority(principal));
  }
  async create(principal: ServerPrincipal, request: TerminalCreateRequest) {
    return (await this.#service(effectiveExecutorId(request.executorId))).create(delegatedAuthority(principal), request);
  }
  async rename(principal: ServerPrincipal, terminalId: string, title: string | null) {
    return (await this.#service(this.#executorId(terminalId))).rename(delegatedAuthority(principal), terminalId, title);
  }
  async terminate(principal: ServerPrincipal, terminalId: string, requestId: string) {
    return (await this.#service(this.#executorId(terminalId))).terminate(delegatedAuthority(principal), terminalId, requestId);
  }
  async attach(principal: ServerPrincipal, peer: TerminalPeer, request: Extract<TerminalStreamClientMessage, { type: 'terminal-attach' }>) {
    const authority = delegatedAuthority(principal);
    if (!request.attachmentId) throw new TerminalError('terminal-validation', 'Terminal attachment identity is required.');
    const executorId = this.#executorId(request.terminalId);
    this.#detach(authority, peer, request.terminalId);
    let entries = this.#attachments.get(peer);
    if (!entries) { entries = new Map(); this.#attachments.set(peer, entries); }
    if (entries.size >= 256) throw new TerminalError('terminal-backpressure', 'Too many terminal subscriptions.', 429);
    const attachment: Attachment = { id: request.attachmentId, authority, service: null, retired: false, peer: {
      connectionId: crypto.randomUUID(), ownedTerminalIds: new Set(),
      sendTerminalMessage: message => {
        if (attachment.retired) return;
        if (message.type === 'terminal-attached') peer.ownedTerminalIds.add(request.terminalId);
        if (message.type === 'terminal-taken-over' || message.type === 'terminal-terminated') peer.ownedTerminalIds.delete(request.terminalId);
        peer.sendTerminalMessage({ ...message, attachmentId: attachment.id });
        if (message.type === 'terminal-terminated' || (message.type === 'terminal-error' && ['terminal-unavailable', 'terminal-backpressure', 'terminal-auth-expired'].includes(message.code))) this.#detach(authority, peer, request.terminalId, attachment.id);
      },
    } };
    entries.set(request.terminalId, attachment);
    try {
      const service = await this.#service(executorId);
      if (attachment.retired) return;
      attachment.service = service;
      await service.attach(authority, attachment.peer, request);
    } catch (error) {
      if (!(error instanceof TerminalError && error.code === 'terminal-takeover-required')) this.#detach(authority, peer, request.terminalId, attachment.id);
      throw error;
    }
  }
  input(principal: ServerPrincipal, peer: TerminalPeer, terminalId: string, data: string, attachmentId?: string) {
    const authority = delegatedAuthority(principal);
    const attachment = this.#require(authority, peer, terminalId, attachmentId);
    return attachment.service!.input(authority, attachment.peer, terminalId, data);
  }
  resize(principal: ServerPrincipal, peer: TerminalPeer, terminalId: string, cols: number, rows: number, attachmentId?: string) {
    const authority = delegatedAuthority(principal);
    const attachment = this.#require(authority, peer, terminalId, attachmentId);
    return attachment.service!.resize(authority, attachment.peer, terminalId, cols, rows);
  }
  detachTerminal(principal: ServerPrincipal, peer: TerminalPeer, terminalId: string, attachmentId?: string): void {
    this.#detach(delegatedAuthority(principal), peer, terminalId, attachmentId);
  }
  #detach(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, attachmentId?: string): void {
    const entries = this.#attachments.get(peer);
    const attachment = entries?.get(terminalId);
    if (!attachment || (attachmentId !== undefined && attachment.id !== attachmentId) || attachment.authority.key !== authority.key) return;
    entries!.delete(terminalId);
    if (!entries!.size) this.#attachments.delete(peer);
    attachment.retired = true;
    peer.ownedTerminalIds.delete(terminalId);
    attachment.service?.detachPeer(authority, attachment.peer);
  }
  detachPeer(principal: ServerPrincipal, peer: TerminalPeer): void {
    for (const id of this.#attachments.get(peer)?.keys() ?? []) this.#detach(delegatedAuthority(principal), peer, id);
  }
  shutdown(): void {
    for (const [peer, entries] of this.#attachments) for (const [id, attachment] of entries) this.#detach(attachment.authority, peer, id);
  }
  #require(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, id?: string): Attachment {
    const attachment = this.#attachments.get(peer)?.get(terminalId);
    if (!attachment?.service || attachment.id !== id || attachment.authority.key !== authority.key) throw new TerminalError('terminal-not-attached', 'Terminal attachment is unavailable.', 409);
    return attachment;
  }
  #executorId(terminalId: string): string {
    const ref = parseTerminalReference(terminalId);
    if (!ref) throw new TerminalError('terminal-validation', 'Invalid terminal reference.');
    return ref.executorId;
  }
  async #service(executorId: string): Promise<ExecutionTerminalService> {
    try { return await this.executors.requireExecutor(executorId).getTerminalService(); }
    catch (error) {
      if (error instanceof AgentCallError && error.code === 'OPERATION_UNSUPPORTED') throw new TerminalError('terminal-unsupported', 'This executor does not support terminals.', 501);
      throw new TerminalError('terminal-unavailable', 'Terminal executor is unavailable.', 503);
    }
  }
}

export function terminalOperationError(error: unknown): TerminalError {
  if (error instanceof TerminalError) return error;
  if (error instanceof AgentCallError) return error.outcome === 'unknown'
    ? new TerminalError('terminal-outcome-unknown', 'Terminal operation may have completed. Reconcile the terminal list before retrying.', 503)
    : new TerminalError('terminal-unavailable', 'Terminal executor is unavailable.', 503);
  return new TerminalError('terminal-internal', 'Terminal operation failed.', 500);
}
