import {
  AgentIntegrationError,
  type AgentExecutionHandle,
  type AgentEstablishedSession,
  type AgentExecutionV5,
  type AgentLogger,
  type AgentEmissionSink,
  type AgentGoalControlRequest,
  type AgentResumeRequestV5,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import type {
  AgentRuntimeEvent,
  AgentRuntimePublisher,
  AgentRuntimeExecution,
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
}

interface ProducerBinding {
  readonly output: AgentEmissionSink;
  publishedSession: AgentEstablishedSession | null;
  currentControlOccurrence: ControlOccurrence | null;
}

export interface AgentProducerAdapter {
  readonly execution: AgentExecutionV5;
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
    const created: ProducerBinding = { output, publishedSession: null, currentControlOccurrence: null };
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
      if (event.type === 'session') occurrence.agentSessionId = event.session.agentSessionId;
      if (event.type === 'run-ended' && event.runId === occurrence.runId) {
        retireControlOccurrence(binding, occurrence);
      }
      if (event.type === 'permission' && !validRunId(event.runId)) {
        logger.warn('Dropped an unnamed provider permission event', {
          chatId,
          eventType: 'permission',
          reason: 'missing operation run ID',
        });
        return;
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
    const occurrence: ControlOccurrence = { chatId, runId, agentSessionId, publish };
    binding.currentControlOccurrence = occurrence;
    return occurrence;
  }

  const execution: AgentExecutionV5 = {
    async start(request) {
      const binding = bindingFor(request.output);
      const occurrence = occurrenceFor(binding, request.chatId, request.runId, null);
      try {
        const session = await runtime.start(withoutOutput(request), occurrence.publish);
        occurrence.agentSessionId = session.agentSessionId;
        if (!sameSession(binding.publishedSession, session)) {
          binding.output.emit({ type: 'session', session });
          binding.publishedSession = session;
        }
        return handle(session.agentSessionId, occurrence.publish);
      } catch (error) {
        retireControlOccurrence(binding, occurrence);
        throw error;
      }
    },

    async resume(request) {
      const binding = bindingFor(request.output);
      const occurrence = occurrenceFor(binding, request.chatId, request.runId, request.agentSessionId);
      try {
        const completion = runtime.resume(withoutOutput(request), occurrence.publish);
        void completion.catch((error) => {
          occurrence.publish({
            type: 'run-ended',
            runId: occurrence.runId,
            outcome: 'failed',
            error: failureDetail(error),
          });
        });
        return handle(request.agentSessionId, occurrence.publish);
      } catch (error) {
        retireControlOccurrence(binding, occurrence);
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

  const compact: AgentProducerAdapter['compact'] = async (request, operation) => {
    const binding = bindingFor(request.output);
    const occurrence = occurrenceFor(binding, request.chatId, request.runId, request.agentSessionId);
    try {
      await operation(withoutOutput(request), occurrence.publish);
      return handle(request.agentSessionId, occurrence.publish);
    } catch (error) {
      retireControlOccurrence(binding, occurrence);
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
            handoff.commit();
            occurrence.runId = request.runId;
            expectedRunId = request.runId;
          },
        });
      },
    }, occurrence.publish);
  };

  return { execution, compact, submitGoalControl };
}

function retireControlOccurrence(binding: ProducerBinding, occurrence: ControlOccurrence): void {
  if (binding.currentControlOccurrence === occurrence) binding.currentControlOccurrence = null;
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
