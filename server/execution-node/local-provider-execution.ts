import type {
  AgentCompaction,
  AgentExecutionHandle,
  AgentExecutionV5,
  AgentIntegration,
  AgentPreparedProviderConfiguration,
  AgentSteering,
  AgentGoals,
  AgentSteerTarget,
  AgentSteerResult,
  AgentNativeSessionRef,
} from '@garcon/server-agent-interface';
import type {
  ProviderExecutionDelivery,
  ProviderExecutionInput,
  ProviderExecutionOperation,
  ProviderExecutionRequest,
  ProviderExecutionService,
  ProviderGoalControlInput,
  ProviderSteerInput,
  ProviderSteerPreparation,
  ProviderSteerTarget,
} from '../execution-nodes/provider-execution.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import type { ProviderConfigurationService } from '../execution-nodes/provider-configuration.js';

const logger = createLogger('execution-node:provider-execution');

interface LocalExecutionOperation {
  readonly request: ProviderExecutionRequest;
  readonly configuration: AgentPreparedProviderConfiguration;
  readonly execution: AgentExecutionV5;
  readonly compaction: AgentCompaction | null;
  readonly steering: AgentSteering | null;
  readonly goals: AgentGoals | null;
  readonly cancellation: AbortController;
  readonly handle: PromiseWithResolvers<AgentExecutionHandle | null>;
  phase: 'prepared' | 'dispatched' | 'released';
  abort: Promise<boolean> | null;
  runId: string;
  ended: boolean;
  session: { agentSessionId: string; nativeSession: AgentNativeSessionRef | null } | null;
  delivery: ProviderExecutionDelivery | null;
  detachCancellation: (() => void) | null;
}

export class LocalProviderExecutionService implements ProviderExecutionService {
  readonly #operations = new WeakMap<ProviderExecutionOperation, LocalExecutionOperation>();
  readonly #steerTargets = new WeakMap<ProviderSteerTarget, {
    execution: LocalExecutionOperation;
    target: AgentSteerTarget;
    session: NonNullable<LocalExecutionOperation['session']>;
  }>();

  constructor(
    private readonly integration: Pick<AgentIntegration, 'descriptor' | 'execution' | 'compaction' | 'steering' | 'goals'>,
    private readonly configuration: Pick<ProviderConfigurationService, 'resolve'>,
  ) {}

  async prepare(input: ProviderExecutionRequest, signal: AbortSignal): Promise<ProviderExecutionOperation> {
    signal.throwIfAborted();
    const request = structuredClone(input);
    const execution = this.integration.execution;
    const compaction = this.integration.compaction;
    const { steering, goals } = this.integration;
    if (request.kind === 'compact' && !compaction) {
      throw new DomainError('VALIDATION_FAILED',
        `${this.integration.descriptor.id} does not support native compaction. Use /handoff to continue in a new chat instead.`, 400);
    }
    const configuration = await this.configuration.resolve(request.configuration, signal);
    signal.throwIfAborted();
    const operation = Object.freeze({}) as ProviderExecutionOperation;
    const cancellation = new AbortController();
    this.#operations.set(operation, {
      request, configuration: structuredClone(configuration), cancellation, execution, compaction,
      steering, goals,
      handle: Promise.withResolvers<AgentExecutionHandle | null>(),
      phase: 'prepared',
      abort: null,
      runId: request.runId, ended: false, delivery: null, detachCancellation: null,
      session: request.kind === 'start' ? null : { agentSessionId: request.agentSessionId, nativeSession: request.nativeSession },
    });
    return operation;
  }

  async dispatch(
    operation: ProviderExecutionOperation,
    input: ProviderExecutionInput,
    delivery: ProviderExecutionDelivery,
  ): Promise<void> {
    const execution = this.#require(operation);
    execution.cancellation.signal.throwIfAborted();
    if (execution.phase !== 'prepared') throw new Error(`Provider execution was already ${execution.phase}`);
    execution.phase = 'dispatched';
    let handle: AgentExecutionHandle | null = null;
    try {
      const { request } = execution;
      const content = {
        prompt: input.prompt,
        attachments: input.attachments.map((attachment) => ({ ...attachment })),
        carriedContext: input.carriedContext === null ? null : { ...input.carriedContext },
      };
      if (request.kind !== 'start' && content.carriedContext !== null) {
        throw new TypeError('Only a new native session accepts carried context');
      }
      const signal = AbortSignal.any([execution.cancellation.signal, delivery.admission.signal]);
      // Admission cancellation can win before a native handle exists or after dispatch returns.
      const cancel = () => {
        void this.#abortExecution(execution).catch(() => {
          logger.warn('Provider cancellation could not be confirmed', { chatId: request.chatId });
        });
      };
      if (signal.aborted) cancel();
      else {
        signal.addEventListener('abort', cancel, { once: true });
        execution.detachCancellation = () => signal.removeEventListener('abort', cancel);
      }
      signal.throwIfAborted();
      execution.delivery = {
        output: {
          emit: (event) => {
            const session = event.type === 'session' ? {
              agentSessionId: event.session.agentSessionId,
              nativeSession: structuredClone(event.session.nativeSession),
            } : null;
            if (event.type === 'run-ended' && event.runId === execution.runId) {
              execution.ended = true;
              execution.detachCancellation?.();
              execution.detachCancellation = null;
            }
            delivery.output.emit(event);
            if (session) execution.session = session;
          },
        },
        admission: {
          signal,
          async markStarted() {
            signal.throwIfAborted();
            await delivery.admission.markStarted();
            signal.throwIfAborted();
          },
        },
      };
      const context = {
        ...structuredClone(execution.configuration),
        chatId: request.chatId,
        projectPath: request.projectPath,
        runId: request.runId,
        ...execution.delivery,
        prompt: content.prompt,
        attachments: content.attachments,
      };
      if (request.kind === 'start') {
        handle = await execution.execution.start({ ...context, carriedContext: content.carriedContext });
      } else {
        const resume = { ...context, agentSessionId: request.agentSessionId, nativeSession: structuredClone(request.nativeSession) };
        if (request.kind === 'compact') {
          const compaction = execution.compaction;
          if (!compaction) throw new Error('Prepared compaction capability is missing');
          handle = await compaction.compact(resume);
        } else {
          handle = await execution.execution.resume(resume);
        }
      }
    } finally {
      execution.handle.resolve(handle);
      if (handle === null) {
        execution.ended = true;
        execution.detachCancellation?.();
        execution.detachCancellation = null;
      }
    }
  }

  release(operation: ProviderExecutionOperation): void {
    const execution = this.#require(operation);
    if (execution.phase !== 'prepared') return;
    execution.phase = 'released';
    execution.handle.resolve(null);
  }

  async abort(operation: ProviderExecutionOperation): Promise<boolean> {
    const execution = this.#require(operation);
    if (execution.phase !== 'dispatched') {
      execution.cancellation.abort(new DOMException('Provider execution cancelled', 'AbortError'));
      this.release(operation);
      return false;
    }
    return this.#abortExecution(execution);
  }

  async prepareSteer(operation: ProviderExecutionOperation, signal: AbortSignal): Promise<ProviderSteerPreparation> {
    signal.throwIfAborted();
    const execution = this.#require(operation);
    if (!this.#live(execution) || !execution.session) return { kind: 'unavailable' };
    if (!execution.steering) return { kind: 'unsupported' };
    const session = structuredClone(execution.session);
    const target = execution.steering.captureTarget({ chatId: execution.request.chatId, ...session });
    if (!target) return { kind: 'unavailable' };
    const prepared = Object.freeze({}) as ProviderSteerTarget;
    this.#steerTargets.set(prepared, { execution, session, target });
    return { kind: 'ready', target: prepared };
  }

  async steer(operation: ProviderExecutionOperation, target: ProviderSteerTarget, input: ProviderSteerInput): Promise<AgentSteerResult> {
    const execution = this.#require(operation);
    const prepared = this.#steerTargets.get(target);
    if (!prepared || prepared.execution !== execution) throw new TypeError('Provider steering target is invalid');
    this.#steerTargets.delete(target);
    const steering = execution.steering;
    if (!this.#live(execution) || !steering) {
      return { kind: 'rejected', reason: 'turn-changed', message: 'Provider execution ended before steering delivery' };
    }
    return steering.steer({
      chatId: execution.request.chatId, projectPath: execution.request.projectPath,
      ...prepared.session, target: prepared.target, ...input,
      prepareDelivery: async () => {
        if (!this.#live(execution)) throw new Error('Provider execution ended before steering delivery');
        await input.prepareDelivery();
        if (!this.#live(execution)) throw new Error('Provider execution ended during steering preparation');
      },
    });
  }

  async submitGoalControl(operation: ProviderExecutionOperation, input: ProviderGoalControlInput, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const execution = this.#require(operation);
    const { goals, delivery } = execution;
    if (!this.#live(execution) || !goals || !delivery || !execution.session) return false;
    const request = { ...input, configuration: structuredClone(input.configuration), attachments: [...input.attachments] };
    const session = structuredClone(execution.session);
    let expectedRunId = execution.runId;
    const configuration = await this.configuration.resolve(request.configuration, signal);
    signal.throwIfAborted();
    if (!this.#live(execution) || execution.runId !== expectedRunId) return false;
    return goals.submitControl({
      ...configuration, ...session, ...delivery,
      chatId: execution.request.chatId, projectPath: execution.request.projectPath,
      runId: request.runId, prompt: request.prompt, attachments: request.attachments,
      beforeDelivery: async (handoff) => {
        const validate = () => {
          signal.throwIfAborted();
          if (!this.#live(execution) || execution.runId !== expectedRunId) throw new Error('Provider execution changed before goal delivery');
          handoff.validate();
        };
        validate();
        await request.beforeDelivery({
          validate,
          commit: () => {
            validate();
            handoff.commit();
            execution.runId = expectedRunId = request.runId;
          },
        });
      },
    });
  }

  #live(execution: LocalExecutionOperation): boolean {
    return execution.phase === 'dispatched' && !execution.ended && !execution.cancellation.signal.aborted;
  }

  #abortExecution(execution: LocalExecutionOperation): Promise<boolean> {
    if (execution.abort) return execution.abort;
    execution.abort = execution.handle.promise.then((handle) => handle ? execution.execution.abort(handle) : false);
    execution.cancellation.abort(new DOMException('Provider execution cancelled', 'AbortError'));
    return execution.abort;
  }

  #require(operation: ProviderExecutionOperation): LocalExecutionOperation {
    const execution = this.#operations.get(operation);
    if (!execution) throw new TypeError('Provider execution operation is invalid');
    return execution;
  }
}
