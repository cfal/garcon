import type { ProducerStreamIdentity } from '@garcon/server-agent-interface';
import type { ProviderExecutionOutput } from '../execution-nodes/provider-execution.js';
import { sameNodeSession, type NodeOperationIdentity } from '../../common/node-operation.js';
import type { NodeBulkIdentity } from '../execution-nodes/transport/bulk-wire.js';
import { parseNodeExecutionBody, type NodeExecutionBody } from '../execution-nodes/transport/execution-body-wire.js';
import { isNodeExecutionReconciliation, type NodeExecutionCommand } from '../execution-nodes/transport/execution-wire.js';
import { NODE_EXECUTION_ERROR_CODES, type NodeExecutionResult, type NodeExecutionErrorCode } from '../execution-nodes/transport/execution-receipt-wire.js';
import { DomainError } from '../lib/domain-error.js';
import type { NodeOperationTable } from './operation-table.js';
import { NodeAuthorityError, type NodeConnectionLease, type NodeSupervisor } from './supervisor.js';

export interface NodeExecutionWireCapabilities {
  /** Consumes verified bytes only for the exact preinstalled operation/control grant. */
  takeBody(body: NodeBulkIdentity, identity: NodeOperationIdentity, kind: NodeExecutionBody['kind'], controlId: string | null): Uint8Array;
  /** Resolves an immutable installed stream; an operation cannot select another binding's output. */
  output(stream: ProducerStreamIdentity, identity: NodeOperationIdentity): ProviderExecutionOutput;
}

/** Adapts parsed private DTOs to local capabilities; the physical driver owns framing and pending-request bounds. */
export class NodeExecutionWireAdapter {
  constructor(
    private readonly table: NodeOperationTable,
    private readonly supervisor: Pick<NodeSupervisor, 'assertConnection' | 'assertAdmission'>,
    private readonly capabilities: NodeExecutionWireCapabilities,
  ) {}

  async execute(connection: NodeConnectionLease, command: NodeExecutionCommand, signal: AbortSignal): Promise<NodeExecutionResult> {
    try {
      this.supervisor.assertConnection(connection);
      if ('identity' in command && !sameNodeSession(command.identity, connection.session)) throw new NodeAuthorityError('NODE_SESSION_EXPIRED', 'Foreign operation');
      if (!isNodeExecutionReconciliation(command)) this.supervisor.assertAdmission(connection);
      switch (command.method) {
        case 'prepare': return { kind: 'prepared', ticket: await this.table.prepare(connection, command.location, command.request, signal) };
        case 'dispatch': {
          const output = this.capabilities.output(command.stream, command.identity);
          const body = this.#body(command.body, command.identity, 'execution', null);
          if (body.kind !== 'execution') throw new InvalidExecutionBody();
          const outcome = await this.table.dispatch(connection, command.identity, body.input, output);
          if (outcome.kind === 'accepted') return { kind: 'dispatched' };
          if (outcome.kind === 'unknown') return { kind: 'unknown' };
          throw outcome.error;
        }
        case 'release': this.table.release(connection, command.identity); return { kind: 'released' };
        case 'abort': return { kind: 'abort-result', requested: await this.table.abort(connection, command.identity) };
        case 'abort-run': return { kind: 'abort-result', requested: await this.table.abortRun(connection, command.identity, command.runId) };
        case 'status': {
          const result = this.table.status(connection, command.identity);
          return { kind: 'status', receipt: result.kind === 'completed' ? result.value : null };
        }
        case 'prepare-steer': return { kind: 'control-prepared', preparation: await this.table.prepareSteer(connection, command.identity, signal) };
        case 'commit-steer': {
          const body = this.#body(command.body, command.identity, 'steer', command.controlId);
          if (body.kind !== 'steer') throw new InvalidExecutionBody();
          const { result, deliveryPrepared } = await this.table.commitSteer(connection, command.identity, command.controlId,
            { input: body.input, clientMessageId: body.clientMessageId });
          const outcome = result.kind === 'accepted' ? { kind: 'accepted' as const }
            : result.kind === 'rejected' ? { kind: 'rejected' as const, reason: result.reason }
              : { kind: 'failed' as const, outcome: result.outcome };
          return { kind: 'steer-result', outcome, deliveryPrepared };
        }
        case 'prepare-goal': {
          const body = this.#body(command.body, command.identity, 'goal', null);
          if (body.kind !== 'goal') throw new InvalidExecutionBody();
          return { kind: 'control-prepared', preparation: await this.table.prepareGoalControl(connection, command.identity,
            { runId: command.runId, configuration: command.configuration, prompt: body.prompt, attachments: body.attachments }, signal) };
        }
        case 'commit-goal': return { kind: 'goal-result', outcome: await this.table.commitGoalControl(connection, command.identity, command.controlId) };
        case 'cancel-control': return { kind: 'control-cancelled', cancelled: this.table.cancelControl(connection, command.identity, command.controlId) };
      }
    } catch (error) {
      if (error instanceof InvalidExecutionBody) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
      if ((error instanceof DomainError || error instanceof NodeAuthorityError) && NODE_EXECUTION_ERROR_CODES.some((code) => code === error.code)) {
        return { kind: 'rejected', code: error.code as NodeExecutionErrorCode };
      }
      if (command.method === 'prepare' || command.method === 'dispatch') return { kind: 'rejected', code: 'NODE_EXECUTION_FAILED' };
      return { kind: 'unknown' };
    }
  }

  #body(identity: NodeBulkIdentity, operation: NodeOperationIdentity, kind: NodeExecutionBody['kind'], controlId: string | null): NodeExecutionBody {
    const bytes = this.capabilities.takeBody(identity, operation, kind, controlId);
    try {
      const body = parseNodeExecutionBody(bytes);
      if (!body || body.kind !== kind) throw new InvalidExecutionBody();
      return body;
    } finally { bytes.fill(0); }
  }
}

class InvalidExecutionBody extends Error {}
