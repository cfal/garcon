import {
  AgentIntegrationError,
  type AgentExecutionHandle,
  type AgentEstablishedSession,
  type AgentExecutionV5,
  type AgentLogger,
  type AgentEmissionSink,
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
  readonly output: AgentEmissionSink;
  publishedSession: AgentEstablishedSession | null;
}

export interface AgentProducerAdapter {
  readonly execution: AgentExecutionV5;
  runExisting<T extends {
    readonly chatId: string;
    readonly agentSessionId: string;
    readonly output: AgentEmissionSink;
  }, R>(
    request: T,
    operation: (request: Omit<T, 'output'>, publish: AgentRuntimePublisher) => Promise<R>,
  ): Promise<{ readonly handle: AgentExecutionHandle; readonly value: R }>;
}

export function createAgentProducerAdapter(
  runtime: AgentRuntimeExecution,
  logger: AgentLogger,
): AgentProducerAdapter {
  // Binding-scoped session bookkeeping is read only at publisher construction, never
  // used to route an arriving event. Publishers retain their exact output capability.
  const bindings = new WeakMap<AgentEmissionSink, ProducerBinding>();

  function bindingFor(output: AgentEmissionSink): ProducerBinding {
    const existing = bindings.get(output);
    if (existing) return existing;
    const created: ProducerBinding = { output, publishedSession: null };
    bindings.set(output, created);
    return created;
  }

  // The capability a runtime publishes through. It closes over one binding, so an operation that
  // outlives its transcript keeps publishing at its own closed sink and has no way to reach a
  // replacement.
  function publisherFor(output: AgentEmissionSink, chatId: string): AgentRuntimePublisher {
    const binding = bindingFor(output);
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
  }

  const execution: AgentExecutionV5 = {
    async start(request) {
      const binding = bindingFor(request.output);
      const session = await runtime.start(
        withoutOutput(request),
        publisherFor(request.output, request.chatId),
      );
      if (!sameSession(binding.publishedSession, session)) {
        binding.output.emit({ type: 'session', session });
        binding.publishedSession = session;
      }
      return handle(session.agentSessionId);
    },

    async resume(request) {
      const binding = bindingFor(request.output);
      const completion = runtime.resume(
        withoutOutput(request),
        publisherFor(request.output, request.chatId),
      );
      void completion.catch((error) => {
        try {
          binding.output.emit({
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
    readonly output: AgentEmissionSink;
  }, R>(
    request: T,
    operation: (request: Omit<T, 'output'>, publish: AgentRuntimePublisher) => Promise<R>,
  ): Promise<{ readonly handle: AgentExecutionHandle; readonly value: R }> {
    const value = await operation(
      withoutOutput(request),
      publisherFor(request.output, request.chatId),
    );
    return { handle: handle(request.agentSessionId), value };
  }

  return { execution, runExisting };
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
