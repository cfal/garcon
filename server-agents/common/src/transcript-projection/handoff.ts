import type {
  AgentHandoffDecision,
  AgentHandoffSeal,
  AgentIncomingOwnershipPreparation,
  AgentOutgoingHandoffLease,
  AgentStreamCheckpoint,
} from '@garcon/server-agent-interface';
import type { AgentProjectionMaterialization } from './state.js';

interface BufferedMutation {
  readonly operation: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface GateLease {
  readonly token: symbol;
  readonly dirty: boolean;
  seal(): AgentHandoffSeal;
  commit(seal: AgentHandoffSeal): void;
  rollback(): Promise<void>;
}

interface GateLeaseState {
  readonly token: symbol;
  buffered: BufferedMutation[];
  sealed: AgentHandoffSeal | null;
}

export class AgentProjectionMutationGate {
  #tail: Promise<void> = Promise.resolve();
  #lease: GateLeaseState | null = null;
  #retired = false;

  constructor(
    private readonly onPostBoundaryMutation: () => Promise<void> = async () => {},
  ) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#lease || this.#retired) {
      if (this.#retired || this.#lease?.sealed) {
        const error = new Error('Projection mutation arrived after sealed handoff boundary');
        const rejected = this.onPostBoundaryMutation().then<T>(
          () => { throw error; },
          (cause) => { throw new AggregateError([error, cause], error.message); },
        );
        this.#tail = rejected.then(() => {}, () => {});
        return rejected;
      }
      return new Promise<T>((resolve, reject) => {
        this.#lease!.buffered.push({
          operation,
          resolve: (value) => resolve(value as T),
          reject,
        });
      });
    }
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => {}, () => {});
    return result;
  }

  async acquire(): Promise<GateLease> {
    await this.#tail;
    if (this.#lease) throw new TypeError('Projection mutation gate already has a lease');
    const state: GateLeaseState = {
      token: Symbol('projection-handoff-lease'),
      buffered: [],
      sealed: null,
    };
    this.#lease = state;
    return {
      token: state.token,
      get dirty() { return state.buffered.length > 0; },
      seal: () => {
        this.#assertLease(state.token);
        if (state.buffered.length > 0) throw new Error('Outgoing projection lease received a buffered mutation');
        if (!state.sealed) state.sealed = Object.freeze({}) as AgentHandoffSeal;
        return state.sealed;
      },
      commit: (seal) => {
        this.#assertLease(state.token);
        if (state.sealed !== seal) throw new TypeError('Handoff seal does not belong to this lease');
        this.#lease = null;
        this.#retired = true;
        const error = new Error('Projection mutation arrived after committed handoff boundary');
        for (const buffered of state.buffered) buffered.reject(error);
      },
      rollback: async () => {
        this.#assertLease(state.token);
        this.#lease = null;
        for (const buffered of state.buffered) {
          await this.run(buffered.operation).then(buffered.resolve, buffered.reject);
        }
      },
    };
  }

  #assertLease(token: symbol): void {
    if (this.#lease?.token !== token) throw new TypeError('Projection mutation lease is no longer active');
  }
}

export async function prepareOutgoingHandoffLease(options: {
  readonly operationId: string;
  readonly gate: AgentProjectionMutationGate;
  readonly materialization: () => AgentProjectionMaterialization;
  readonly afterDecision: (decision: AgentHandoffDecision) => Promise<void>;
  readonly beforeRollback?: () => Promise<void>;
}): Promise<AgentOutgoingHandoffLease> {
  const gateLease = await options.gate.acquire();
  const current = options.materialization();
  if (current.checkpoint.projection.total !== current.checkpoint.projection.durableCount) {
    await gateLease.rollback();
    throw new TypeError('Outgoing handoff cannot freeze an active transcript suffix');
  }
  const frozen = {
    checkpoint: current.checkpoint,
    entries: current.entries.map((entry) => ({ ...entry })),
  };
  let decided = false;
  return {
    operationId: options.operationId,
    frozen,
    sealForDecision: () => gateLease.seal(),
    commitAfterDecision: async (seal, decision) => {
      if (decision.operationId !== options.operationId) throw new TypeError('Handoff decision mismatch');
      gateLease.commit(seal);
      decided = true;
      await options.afterDecision(decision);
    },
    rollbackBeforeDecision: async () => {
      if (decided) throw new TypeError('A decided handoff cannot roll back');
      await options.beforeRollback?.();
      await gateLease.rollback();
    },
  };
}

export function prepareIncomingOwnershipSegment(options: {
  readonly checkpoint: AgentStreamCheckpoint;
  readonly commit: (decision: AgentHandoffDecision) => Promise<void>;
  readonly rollback: () => Promise<void>;
}): AgentIncomingOwnershipPreparation {
  let state: 'prepared' | 'committed' | 'rolled-back' = 'prepared';
  return {
    checkpoint: options.checkpoint,
    commitAfterDecision: async (decision) => {
      if (state === 'committed') return;
      if (state !== 'prepared') throw new TypeError('Rolled-back ownership preparation cannot commit');
      await options.commit(decision);
      state = 'committed';
    },
    rollbackBeforeDecision: async () => {
      if (state === 'rolled-back') return;
      if (state !== 'prepared') throw new TypeError('Committed ownership preparation cannot roll back');
      await options.rollback();
      state = 'rolled-back';
    },
  };
}
