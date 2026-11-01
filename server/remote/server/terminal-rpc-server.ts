import type { ExecutionTerminalService, TerminalAuthority, TerminalPeer } from '@garcon/server-agent-interface';
import { TerminalError } from '../../../common/terminal-error.js';
import { expandTerminalMessageForDelivery } from '../../common/terminal-framing.js';
import type { ExecutorRpc } from '../transport/rpc.js';
import { validateTerminalRpc, parseTerminalNotification, type TerminalCreator, type TerminalRpcMethods, type TerminalRpcRequest } from '../transport/terminal-protocol.js';
import { resolveRpc, type RpcWire } from '../transport/rpc-registrations.js';

interface Attachment {
  readonly creator: TerminalCreator;
  readonly authority: TerminalAuthority;
  readonly terminalId: string;
  readonly peer: TerminalPeer;
  timer: ReturnType<typeof setTimeout> | null;
}

export class TerminalRpcServer {
  readonly #attachments = new Map<string, Attachment>();
  constructor(private readonly service: ExecutionTerminalService, private readonly rpc: ExecutorRpc) {}

  async handle(call: TerminalRpcRequest, wire: RpcWire): Promise<unknown> {
    validateTerminalRpc(call);
    const { authority } = call.request;
    switch (call.method) {
      case 'terminals.list': return this.service.list(authority);
      case 'terminals.create': return this.service.create(authority, call.request);
      case 'terminals.rename': return this.service.rename(authority, call.request.terminalId, call.request.title);
      case 'terminals.terminate': return this.service.terminate(authority, call.request.terminalId, call.request.requestId);
      case 'terminals.attach': {
        const request = call.request;
        const creator = wire.terminal;
        if (!creator) throw new Error('Terminal server codec is not registered');
        if (this.#attachments.has(request.attachmentId) || this.#attachments.size >= 256) throw new TerminalError('terminal-backpressure', 'Terminal attachment budget exhausted.', 429);
        const attachment: Attachment = { creator, authority, terminalId: request.terminalId, timer: null, peer: {
          connectionId: request.attachmentId, ownedTerminalIds: new Set(),
          sendTerminalMessage: (message) => {
            for (const part of expandTerminalMessageForDelivery(message)) {
              if (this.#attachments.get(request.attachmentId) !== attachment) return;
              const frame = parseTerminalNotification({ type: 'terminal', attachmentId: request.attachmentId, message: part }, attachment.creator);
              if (!this.rpc.publishTerminal(frame)) {
                this.#detach(request.attachmentId);
                this.rpc.publishTerminalControl(parseTerminalNotification({ type: 'terminal', attachmentId: request.attachmentId, message: {
                  type: 'terminal-error', terminalId: request.terminalId, code: 'terminal-backpressure', message: 'Terminal output detached; reattach to resume.',
                } }, creator));
                return;
              }
            }
            if (message.type === 'terminal-terminated') this.#detach(request.attachmentId);
          },
        } };
        this.#attachments.set(request.attachmentId, attachment);
        const expire = () => {
          if (authority.expiresAtMs === null) return;
          const delay = authority.expiresAtMs - Date.now();
          if (delay <= 0) { this.#detach(request.attachmentId); return; }
          attachment.timer = setTimeout(expire, Math.min(delay, 2_147_000_000)); attachment.timer.unref();
        };
        expire();
        try { await this.service.attach(authority, attachment.peer, request); }
        catch (error) {
          if (!(error instanceof TerminalError && error.code === 'terminal-takeover-required')) this.#detach(request.attachmentId);
          throw error;
        }
        return;
      }
      default: {
        const request = call.request;
        const attachment = this.#attachments.get(request.attachmentId);
        if (!attachment || attachment.authority.key !== authority.key || attachment.authority.expiresAtMs !== authority.expiresAtMs
          || attachment.terminalId !== request.terminalId || attachment.creator.resource.name !== wire.definition.acceptsResource?.name
          || attachment.creator.resource.version !== wire.definition.acceptsResource.version) throw new TerminalError('terminal-not-attached', 'Terminal attachment expired.', 409);
        if (call.method === 'terminals.detach') { this.#detach(request.attachmentId); return; }
        if (call.method === 'terminals.input') return this.service.input(authority, attachment.peer, request.terminalId, call.request.data);
        return this.service.resize(authority, attachment.peer, request.terminalId, call.request.cols, call.request.rows);
      }
    }
  }

  disconnect(): void { for (const id of this.#attachments.keys()) this.#detach(id); }

  async detach(request: TerminalRpcMethods['terminals.detach']['request']): Promise<void> {
    const attachment = this.#attachments.get(request?.attachmentId);
    if (!attachment) return;
    const wire = resolveRpc(this.rpc.transport.protocol, attachment.creator.detach, 'receive');
    await this.handle({ method: attachment.creator.detach.name, version: attachment.creator.detach.version, request }, wire);
  }

  #detach(id: string): void {
    const attachment = this.#attachments.get(id);
    if (!attachment) return;
    this.#attachments.delete(id);
    if (attachment.timer) clearTimeout(attachment.timer);
    this.service.detachPeer(attachment.authority, attachment.peer);
  }
}
