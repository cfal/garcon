import { AgentCallError, type ExecutionNode, type ExecutionTerminalService, type TerminalAuthority, type TerminalPeer } from '@garcon/server-agent-interface';
import type { TerminalCreateRequest, TerminalStreamClientMessage } from '../../common/terminal.js';
import { TerminalError } from '../../common/terminal-error.js';
import { parseTerminalReference } from '../../common/terminal-identity.js';
import { effectiveNodeId } from '../../common/execution-nodes.js';

interface Attachment {
  readonly id: string;
  readonly authority: TerminalAuthority;
  readonly peer: TerminalPeer;
  service: ExecutionTerminalService | null;
  retired: boolean;
}

export class TerminalController {
  readonly #attachments = new Map<TerminalPeer, Map<string, Attachment>>();
  constructor(private readonly nodes: { requireNode(id: string): ExecutionNode }) {}

  async list(authority: TerminalAuthority, nodeId = 'local') {
    return (await this.#service(nodeId)).list(authority);
  }
  async create(authority: TerminalAuthority, request: TerminalCreateRequest) {
    return (await this.#service(effectiveNodeId(request.nodeId))).create(authority, request);
  }
  async rename(authority: TerminalAuthority, terminalId: string, title: string | null) {
    return (await this.#service(this.#nodeId(terminalId))).rename(authority, terminalId, title);
  }
  async terminate(authority: TerminalAuthority, terminalId: string, requestId: string) {
    return (await this.#service(this.#nodeId(terminalId))).terminate(authority, terminalId, requestId);
  }
  async attach(authority: TerminalAuthority, peer: TerminalPeer, request: Extract<TerminalStreamClientMessage, { type: 'terminal-attach' }>) {
    if (!request.attachmentId) throw new TerminalError('terminal-validation', 'Terminal attachment identity is required.');
    const nodeId = this.#nodeId(request.terminalId);
    this.detachTerminal(authority, peer, request.terminalId);
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
        if (message.type === 'terminal-terminated') this.detachTerminal(authority, peer, request.terminalId, attachment.id);
      },
    } };
    entries.set(request.terminalId, attachment);
    try {
      const service = await this.#service(nodeId);
      if (attachment.retired) return;
      attachment.service = service;
      await service.attach(authority, attachment.peer, request);
    } catch (error) {
      if (!(error instanceof TerminalError && error.code === 'terminal-takeover-required')) this.detachTerminal(authority, peer, request.terminalId, attachment.id);
      throw error;
    }
  }
  input(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, data: string, attachmentId?: string) {
    const attachment = this.#require(authority, peer, terminalId, attachmentId);
    return attachment.service!.input(authority, attachment.peer, terminalId, data);
  }
  resize(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, cols: number, rows: number, attachmentId?: string) {
    const attachment = this.#require(authority, peer, terminalId, attachmentId);
    return attachment.service!.resize(authority, attachment.peer, terminalId, cols, rows);
  }
  detachTerminal(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, attachmentId?: string): void {
    const entries = this.#attachments.get(peer);
    const attachment = entries?.get(terminalId);
    if (!attachment || (attachmentId !== undefined && attachment.id !== attachmentId) || attachment.authority.key !== authority.key) return;
    entries!.delete(terminalId);
    if (!entries!.size) this.#attachments.delete(peer);
    attachment.retired = true;
    peer.ownedTerminalIds.delete(terminalId);
    attachment.service?.detachPeer(authority, attachment.peer);
  }
  detachPeer(authority: TerminalAuthority, peer: TerminalPeer): void {
    for (const id of this.#attachments.get(peer)?.keys() ?? []) this.detachTerminal(authority, peer, id);
  }
  shutdown(): void {
    for (const [peer, entries] of this.#attachments) for (const [id, attachment] of entries) this.detachTerminal(attachment.authority, peer, id);
  }
  #require(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, id?: string): Attachment {
    const attachment = this.#attachments.get(peer)?.get(terminalId);
    if (!attachment?.service || attachment.id !== id || attachment.authority.key !== authority.key) throw new TerminalError('terminal-not-attached', 'Terminal attachment is unavailable.', 409);
    return attachment;
  }
  #nodeId(terminalId: string): string {
    const ref = parseTerminalReference(terminalId);
    if (!ref) throw new TerminalError('terminal-validation', 'Invalid terminal reference.');
    return ref.nodeId;
  }
  async #service(nodeId: string): Promise<ExecutionTerminalService> {
    try { return await this.nodes.requireNode(nodeId).getTerminalService(); }
    catch (error) {
      if (error instanceof AgentCallError && error.code === 'OPERATION_UNSUPPORTED') throw new TerminalError('terminal-unsupported', 'This node does not support terminals.', 501);
      throw new TerminalError('terminal-unavailable', 'Terminal node is unavailable.', 503);
    }
  }
}

export function terminalOperationError(error: unknown): TerminalError {
  if (error instanceof TerminalError) return error;
  if (error instanceof AgentCallError) return error.outcome === 'unknown'
    ? new TerminalError('terminal-outcome-unknown', 'Terminal operation may have completed. Reconcile the terminal list before retrying.', 503)
    : new TerminalError('terminal-unavailable', 'Terminal node is unavailable.', 503);
  return new TerminalError('terminal-internal', 'Terminal operation failed.', 500);
}
