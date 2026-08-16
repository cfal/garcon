import {
  AgentIntegrationError,
  type AgentExecutionHandle,
  type AgentEstablishedSession,
  type AgentExecutionV5,
  type AgentLogger,
  type AgentProducerSink,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import type {
  AgentRuntimeEvent,
  AgentRuntimePublisher,
  AgentRuntimeExecution,
} from './runtime-events.js';

interface RuntimeHandle extends AgentExecutionHandle {
  readonly agentSessionId: string;
}

interface ProducerBinding {
  readonly sink: AgentProducerSink;
  publishedSession: AgentEstablishedSession | null;
}

export interface AgentProducerAdapter {
  readonly execution: AgentExecutionV5;
  runExisting<T extends {
    readonly chatId: string;
    readonly agentSessionId: string;
    readonly sink: AgentProducerSink;
  }, R>(
    request: T,
    operation: (request: Omit<T, 'sink'>, publish: AgentRuntimePublisher) => Promise<R>,
  ): Promise<{ readonly handle: AgentExecutionHandle; readonly value: R }>;
}

export function createAgentProducerAdapter(
  runtime: AgentRuntimeExecution,
  logger: AgentLogger,
): AgentProducerAdapter {
  // Keyed by the sink itself so state that outlives a single operation, like the session
  // already published, follows the transcript it belongs to. Nothing routes through this map:
  // it is read when a publisher is built, never when an event arrives. A binding becomes
  // collectible once the runtime releases the last publisher holding it.
  const bindings = new WeakMap<AgentProducerSink, ProducerBinding>();

  function bindingFor(sink: AgentProducerSink): ProducerBinding {
    const existing = bindings.get(sink);
    if (existing) return existing;
    const created: ProducerBinding = { sink, publishedSession: null };
    bindings.set(sink, created);
    return created;
  }

  // The capability a runtime publishes through. It closes over one binding, so an operation that
  // outlives its transcript keeps publishing at its own closed sink and has no way to reach a
  // replacement.
  function publisherFor(sink: AgentProducerSink, chatId: string): AgentRuntimePublisher {
    const binding = bindingFor(sink);
    return (event) => {
      if (event.type === 'permission' && !validRunId(event.runId)) {
        logger.warn('Dropped an unnamed provider permission event', {
          chatId,
          eventType: 'permission',
          reason: 'missing operation run ID',
        });
        return;
      }
      try {
        publishRuntimeEvent(binding, event);
      } catch (error) {
        // A closed or fenced sink rejects synchronously, and this runs inside the provider's own
        // event dispatch - which several runtimes share across every chat. Letting the rejection
        // escape would tear that stream down for unrelated chats, so the event is dropped here
        // under the accepted at-most-once loss.
        logger.warn('Dropped a provider event for an unavailable transcript sink', {
          chatId,
          eventType: event.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  const execution: AgentExecutionV5 = {
    async start(request) {
      const binding = bindingFor(request.sink);
      const session = await runtime.start(
        withoutSink(request),
        publisherFor(request.sink, request.chatId),
      );
      if (!sameSession(binding.publishedSession, session)) {
        binding.sink.publish({ type: 'session', session });
        binding.publishedSession = session;
      }
      return handle(session.agentSessionId);
    },

    async resume(request) {
      const binding = bindingFor(request.sink);
      const completion = runtime.resume(
        withoutSink(request),
        publisherFor(request.sink, request.chatId),
      );
      void completion.catch((error) => {
        try {
          binding.sink.publish({
            type: 'run-ended',
            runId: request.runId,
            outcome: 'failed',
            error: failureDetail(error),
          });
        } catch {
          // A closed or fenced sink already made the failed run historical.
        }
      });
      return handle(request.agentSessionId);
    },

    abort(value) {
      return runtime.abort(runtimeHandle(value).agentSessionId);
    },

    runningSessions: () => runtime.runningSessions(),
  };

  async function runExisting<T extends {
    readonly chatId: string;
    readonly agentSessionId: string;
    readonly sink: AgentProducerSink;
  }, R>(
    request: T,
    operation: (request: Omit<T, 'sink'>, publish: AgentRuntimePublisher) => Promise<R>,
  ): Promise<{ readonly handle: AgentExecutionHandle; readonly value: R }> {
    const value = await operation(
      withoutSink(request),
      publisherFor(request.sink, request.chatId),
    );
    return { handle: handle(request.agentSessionId), value };
  }

  return { execution, runExisting };
}

function validRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function publishRuntimeEvent(binding: ProducerBinding, event: AgentRuntimeEvent): void {
  if (event.type === 'session') {
    binding.publishedSession = event.session;
  }
  binding.sink.publish(event);
}

function sameSession(
  left: AgentEstablishedSession | null,
  right: AgentEstablishedSession,
): boolean {
  return left?.agentSessionId === right.agentSessionId
    && JSON.stringify(left.nativeSession) === JSON.stringify(right.nativeSession)
    && JSON.stringify(left.nativeSeedReceipt) === JSON.stringify(right.nativeSeedReceipt);
}

function withoutSink<T extends { readonly sink: AgentProducerSink }>(request: T): Omit<T, 'sink'> {
  const { sink: _sink, ...runtimeRequest } = request;
  return runtimeRequest;
}

function handle(agentSessionId: string): RuntimeHandle {
  return Object.freeze({ agentSessionId });
}

function runtimeHandle(value: AgentExecutionHandle): RuntimeHandle {
  if (!('agentSessionId' in value) || typeof value.agentSessionId !== 'string') {
    throw new TypeError('Agent execution handle is invalid');
  }
  return value as RuntimeHandle;
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
