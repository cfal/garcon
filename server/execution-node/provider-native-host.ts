import type { ExecutionInstanceRef } from '../../common/execution-location.js';
import type { ProviderNativeSessionService } from '../execution-nodes/provider-native-sessions.js';
import { parseNodeProviderNativeCommand, parseNodeProviderNativeReply, type NodeProviderNativeCommand, type NodeProviderNativeReply } from '../execution-nodes/transport/provider-native-wire.js';
import { DomainError } from '../lib/domain-error.js';
import type { NodeExecutionResources } from './execution-resources.js';
import type { NodeProviderCapacity } from './provider-capacity.js';
import type { NodeNativeExecutionReservation, NodeNativeOccupancy } from './native-occupancy.js';
import type { NodeWorkerServiceResult } from './worker/service-protocol.js';

/** Keeps native cleanup available when a granted project has disappeared; provider settlement releases capacity. */
export class NodeProviderNativeHost {
  constructor(
    private readonly capacity: NodeProviderCapacity,
    private readonly instance: ExecutionInstanceRef,
    private readonly agentId: string,
    private readonly resources: Pick<NodeExecutionResources, 'capture'>,
    private readonly sessions: ProviderNativeSessionService,
    private readonly occupancy: Pick<NodeNativeOccupancy, 'reserveExecution'>,
  ) {
    this.instance = Object.freeze({ ...instance });
  }

  async execute(input: NodeProviderNativeCommand, signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    signal.throwIfAborted();
    const command = parseNodeProviderNativeCommand(input);
    if (!command || command.instanceId !== this.instance.instanceId || command.chat.agentId !== this.agentId) {
      return { kind: 'rejected', code: 'VALIDATION_FAILED' };
    }
    const release = this.capacity.reserve('work');
    if (!release) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    let active = signal;
    let enteredProvider = false;
    let native: NodeNativeExecutionReservation | null = null;
    try {
      const grant = this.resources.capture({ ...this.instance, workspaceId: command.workspaceId });
      active = AbortSignal.any([signal, grant.signal]);
      active.throwIfAborted(); grant.validate();
      if (command.operation === 'release') {
        native = this.occupancy.reserveExecution(command.chat.chatId);
        native.enter();
      }
      const chat = { ...command.chat, projectPath: grant.projectPath };
      const base = { kind: 'provider-native-result', instanceId: command.instanceId, workspaceId: command.workspaceId } as const;
      let reply: NodeProviderNativeReply;
      enteredProvider = true;
      switch (command.operation) {
        case 'resolve': {
          const reference = await this.sessions.resolve({ chat }, active);
          if (reference !== null && reference.ownerId !== this.agentId) return { kind: 'unknown' };
          reply = { ...base, operation: 'resolve', reference };
          break;
        }
        case 'describe': reply = { ...base, operation: 'describe', source: await this.sessions.describe({ chat }, active) }; break;
        case 'release':
          await this.sessions.release({ chat, reason: command.reason }, active);
          reply = { ...base, operation: 'release' };
          break;
      }
      active.throwIfAborted(); grant.validate();
      return parseNodeProviderNativeReply(reply) ?? { kind: 'unknown' };
    } catch (error) {
      active.throwIfAborted();
      if (!enteredProvider && error instanceof DomainError && (error.code === 'NODE_UNAVAILABLE' || error.code === 'NODE_CAPACITY')) {
        return { kind: 'rejected', code: error.code };
      }
      return { kind: 'unknown' };
    } finally { native?.release(); release(); }
  }
}
