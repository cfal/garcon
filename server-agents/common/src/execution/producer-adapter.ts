import {
  AgentIntegrationError,
  type AgentExecutionHandle,
  type AgentEstablishedSession,
  type AgentExecutionV5,
  type AgentExecutionLifetime,
  type AgentDispatchOutcome,
  type AgentLogger,
  type AgentEmissionSink,
  type AgentGoalControlRequest,
  type AgentResumeRequestV5,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import {
  AgentRuntimeAdmissionRejectedError,
  type AgentRuntimeEvent,
  type AgentRuntimePublisher,
  type AgentRuntimeExecution,
  type AgentRuntimeExecutionLifetime,
} from './runtime-events.js';

interface RuntimeHandle {
  readonly agentSessionId: string;
  readonly publish: AgentRuntimePublisher;
}

interface ControlOccurrence {
  readonly chatId: string;
  agentSessionId: string | null;
  runId: string;
  readonly publish: AgentRuntimePublisher;
  readonly order: number;
  phase: 'preparing' | 'admitted' | 'retired';
}

interface ProducerBinding {
  readonly output: AgentEmissionSink;
  publishedSession: AgentEstablishedSession | null;
  currentControlOccurrence: ControlOccurrence | null;
  occurrenceOrder: number;
  controlOrder: number;
}

export interface AgentProducerAdapter {
  readonly execution: AgentExecutionV5;
  readonly executionLifetime: AgentExecutionLifetime | null;
  compact(
    request: AgentResumeRequestV5,
    operation: (request: Omit<AgentResumeRequestV5, 'output'>, publish: AgentRuntimePublisher) => Promise<void>,
  ): Promise<AgentExecutionHandle>;
  submitGoalControl(
    request: AgentGoalControlRequest,
    operation: (request: Omit<AgentGoalControlRequest, 'output'>, publish: AgentRuntimePublisher) => Promise<boolean>,
  ): Promise<boolean>;
}

export function createAgentProducerAdapter(
  runtime: AgentRuntimeExecution,
  logger: AgentLogger,
  lifetime: AgentRuntimeExecutionLifetime | null = null,
): AgentProducerAdapter {
  // Binding-scoped session bookkeeping is read only at publisher construction, never
  // used to route an arriving event. Publishers retain their exact output capability.
  const bindings = new WeakMap<AgentEmissionSink, ProducerBinding>();
  const handles = new WeakMap<AgentExecutionHandle, RuntimeHandle>();

  function handle(agentSessionId: string, publish: AgentRuntimePublisher): AgentExecutionHandle {
    const value = Object.freeze({});
    handles.set(value, { agentSessionId, publish });
    return value;
  }

  function bindingFor(output: AgentEmissionSink): ProducerBinding {
    const existing = bindings.get(output);
    if (existing) return existing;
    const created: ProducerBinding = {
      output, publishedSession: null, currentControlOccurrence: null, occurrenceOrder: 0, controlOrder: 0,
    };
    bindings.set(output, created);
    return created;
  }

  // The capability a runtime publishes through. It closes over one binding, so an operation that
  // outlives its transcript keeps publishing at its own closed sink and has no way to reach a
  // replacement.
  function occurrenceFor(
    binding: ProducerBinding,
    chatId: string,
    runId: string,
    agentSessionId: string | null,
  ): ControlOccurrence {
    const publish: AgentRuntimePublisher = (event) => {
      if (event.type === 'permission' && !validRunId(event.runId)) {
        logger.warn('Dropped an unnamed provider permission event', {
          chatId,
          eventType: 'permission',
          reason: 'missing operation run ID',
        });
        return;
      }
      admitControlOccurrence(binding, occurrence);
      if (event.type === 'session') occurrence.agentSessionId = event.session.agentSessionId;
      if (event.type === 'run-ended' && event.runId === occurrence.runId) {
        retireControlOccurrence(binding, occurrence);
      }
      try {
        emitRuntimeEvent(binding, event);
      } catch (error) {
        // Rejections must not escape a provider dispatcher shared with other chats.
        logger.warn('Dropped a provider event for an unavailable output', {
          chatId,
          eventType: event.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const occurrence: ControlOccurrence = {
      chatId, runId, agentSessionId, publish, order: ++binding.occurrenceOrder, phase: 'preparing',
    };
    return occurrence;
  }

  function runtimeRequest<T extends AgentResumeRequestV5 | Parameters<AgentExecutionV5['start']>[0]>(
    request: T, binding: ProducerBinding, occurrence: ControlOccurrence,
  ): Omit<T, 'output'> {
    return {
      ...withoutOutput(request),
      admission: {
        signal: request.admission.signal,
        markStarted: () => {
          admitControlOccurrence(binding, occurrence);
          return request.admission.markStarted();
        },
      },
    };
  }

  const execution: AgentExecutionV5 = {
    async start(request) {
      const binding = bindingFor(request.output);
      const occurrence = occurrenceFor(binding, request.chatId, request.runId, null);
      try {
        const session = await runtime.start(runtimeRequest(request, binding, occurrence), occurrence.publish);
        establishSession(binding, occurrence, session);
        return handle(session.agentSessionId, occurrence.publish);
      } catch (error) {
        failControlOccurrence(binding, occurrence, error);
        throw error;
      }
    },

    async resume(request) {
      const binding = bindingFor(request.output);
      const occurrence = occurrenceFor(binding, request.chatId, request.runId, request.agentSessionId);
      try {
        const completion = runtime.resume(runtimeRequest(request, binding, occurrence), occurrence.publish);
        void completion.then(() => admitControlOccurrence(binding, occurrence), (error) => {
          failControlOccurrence(binding, occurrence, error);
          occurrence.publish({
            type: 'run-ended',
            runId: occurrence.runId,
            outcome: 'failed',
            error: failureDetail(error),
          });
        });
        return handle(request.agentSessionId, occurrence.publish);
      } catch (error) {
        failControlOccurrence(binding, occurrence, error);
        throw error;
      }
    },

    abort(value) {
      const target = handles.get(value);
      if (!target) throw new TypeError('Agent execution handle is invalid');
      return runtime.abort(target.agentSessionId, target.publish);
    },

    runningSessions: () => runtime.runningSessions(),
  };

  const executionLifetime: AgentExecutionLifetime | null = lifetime === null ? null : {
    begin(input) {
      const { kind, request } = input;
      const binding = bindingFor(request.output);
      const occurrence = occurrenceFor(binding, request.chatId, request.runId,
        kind === 'start' ? null : request.agentSessionId);
      const attempt = lifetime.begin(kind === 'start'
        ? { kind: 'start', request: runtimeRequest(request, binding, occurrence) }
        : { kind, request: runtimeRequest(request, binding, occurrence) }, occurrence.publish);
      const { dispatch: nativeDispatch, settled: nativeSettled, abort } = attempt;
      const dispatch = nativeDispatch.then((outcome): AgentDispatchOutcome => {
        if (outcome.kind !== 'accepted') {
          if (outcome.kind === 'rejected' && occurrence.phase === 'preparing') retireControlOccurrence(binding, occurrence);
          else failControlOccurrence(binding, occurrence, outcome.error);
          return outcome;
        }
        if (kind === 'start') {
          if (outcome.session === null) throw new TypeError('Native start returned no established session');
          establishSession(binding, occurrence, outcome.session);
        } else {
          if (outcome.session !== null) throw new TypeError('Native resume returned an unexpected session');
          admitControlOccurrence(binding, occurrence);
        }
        return { kind: 'accepted' };
      }).catch((error: unknown): AgentDispatchOutcome => {
        failControlOccurrence(binding, occurrence, error);
        return { kind: 'unknown', error };
      });
      const settled = Promise.all([nativeSettled, dispatch]).then(() => {
        retireControlOccurrence(binding, occurrence);
      }, (error: unknown) => {
        failControlOccurrence(binding, occurrence, error);
        throw error;
      });
      return Object.freeze({ dispatch, settled, abort: () => Reflect.apply(abort, attempt, []) });
    },
  };

  const compact: AgentProducerAdapter['compact'] = async (request, operation) => {
    const binding = bindingFor(request.output);
    const occurrence = occurrenceFor(binding, request.chatId, request.runId, request.agentSessionId);
    try {
      await operation(runtimeRequest(request, binding, occurrence), occurrence.publish);
      admitControlOccurrence(binding, occurrence);
      return handle(request.agentSessionId, occurrence.publish);
    } catch (error) {
      failControlOccurrence(binding, occurrence, error);
      throw error;
    }
  };

  const submitGoalControl: AgentProducerAdapter['submitGoalControl'] = async (request, operation) => {
    const binding = bindings.get(request.output);
    const occurrence = binding?.currentControlOccurrence;
    if (!binding || !occurrence || occurrence.chatId !== request.chatId || occurrence.agentSessionId !== request.agentSessionId) {
      return false;
    }
    let expectedRunId = occurrence.runId;
    return operation({
      ...withoutOutput(request),
      beforeDelivery: async (handoff) => {
        const validate = () => {
          if (binding.currentControlOccurrence !== occurrence || occurrence.runId !== expectedRunId) {
            throw new Error('Provider execution occurrence changed before goal control delivery');
          }
          handoff.validate();
        };
        validate();
        await request.beforeDelivery({
          validate,
          commit: () => {
            validate();
            occurrence.runId = request.runId;
            expectedRunId = request.runId;
            handoff.commit();
          },
        });
      },
    }, occurrence.publish);
  };

  return { execution, executionLifetime, compact, submitGoalControl };
}

function establishSession(binding: ProducerBinding, occurrence: ControlOccurrence, session: AgentEstablishedSession): void {
  admitControlOccurrence(binding, occurrence);
  occurrence.agentSessionId = session.agentSessionId;
  if (!sameSession(binding.publishedSession, session)) {
    binding.output.emit({ type: 'session', session });
    binding.publishedSession = session;
  }
}

function retireControlOccurrence(binding: ProducerBinding, occurrence: ControlOccurrence): void {
  occurrence.phase = 'retired';
  if (binding.currentControlOccurrence === occurrence) binding.currentControlOccurrence = null;
}

function admitControlOccurrence(binding: ProducerBinding, occurrence: ControlOccurrence): void {
  if (occurrence.phase !== 'preparing') return;
  occurrence.phase = 'admitted';
  if (occurrence.order <= binding.controlOrder) return;
  binding.controlOrder = occurrence.order;
  binding.currentControlOccurrence = occurrence;
}

function failControlOccurrence(binding: ProducerBinding, occurrence: ControlOccurrence, error: unknown): void {
  if (!(error instanceof AgentRuntimeAdmissionRejectedError) || occurrence.phase !== 'preparing') {
    if (occurrence.order > binding.controlOrder) {
      binding.controlOrder = occurrence.order;
      binding.currentControlOccurrence = null;
    }
  }
  retireControlOccurrence(binding, occurrence);
}

function validRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function emitRuntimeEvent(binding: ProducerBinding, event: AgentRuntimeEvent): void {
  if (event.type === 'session') {
    binding.publishedSession = event.session;
  }
  binding.output.emit(event);
}

function sameSession(
  left: AgentEstablishedSession | null,
  right: AgentEstablishedSession,
): boolean {
  return left?.agentSessionId === right.agentSessionId
    && JSON.stringify(left.nativeSession) === JSON.stringify(right.nativeSession)
    && JSON.stringify(left.nativeSeedReceipt) === JSON.stringify(right.nativeSeedReceipt);
}

function withoutOutput<T extends { readonly output: AgentEmissionSink }>(request: T): Omit<T, 'output'> {
  const { output: _output, ...runtimeRequest } = request;
  return runtimeRequest;
}

export function failureDetail(error: unknown): AgentRunFailureDetail {
  if (error instanceof AgentIntegrationError) {
    return { code: error.code, ...(error.message ? { message: error.message } : {}) };
  }
  return {
    code: 'PROVIDER_FAILURE',
    ...(error instanceof Error && error.message ? { message: error.message } : {}),
  };
}
