import {
  AgentIntegrationError,
} from '@garcon/server-agent-interface';
import {
  runtimeOperation,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
  type AgentRuntimeExecutionContext,
  type AgentRuntimeExecutionLifetime,
  type AgentRuntimeDispatchOutcome,
  type AgentRuntimeExecutionLifetimeRequest,
} from '../execution/runtime-events.js';
import { DirectNativeExecution } from './native-execution.js';
import type { AgentEstablishedSession } from '@garcon/server-agent-interface';
import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import type { DirectEndpointRouterRuntime, DirectCompatibleRuntime } from './router.js';

export class DirectExecution<TRuntime extends DirectCompatibleRuntime>
implements AgentRuntimeExecution, AgentRuntimeExecutionLifetime {
  constructor(
    private readonly runtime: DirectEndpointRouterRuntime<TRuntime>,
  ) {}

  begin(input: Parameters<AgentRuntimeExecutionLifetime['begin']>[0], publish: AgentRuntimePublisher) {
    const captured = captureLifetimeRequest(input);
    const outcome = Promise.withResolvers<AgentRuntimeDispatchOutcome>();
    const work = new DirectNativeExecution(() => {
      if (captured.kind === 'resume') outcome.resolve({ kind: 'accepted', session: null });
    });
    const caller = captured.request.admission.signal;
    const abort = () => { work.abort(); };
    caller.addEventListener('abort', abort, { once: true });
    const signal = AbortSignal.any([caller, work.signal]);
    const admission = { signal, async markStarted() { signal.throwIfAborted(); } };
    const completion = Promise.resolve().then(async (): Promise<void> => {
      try {
        signal.throwIfAborted();
        this.#endpoint(captured.request);
        if (captured.kind === 'compact') throw new Error('Direct execution does not support native compaction');
        await captured.request.admission.markStarted();
        signal.throwIfAborted();
        work.enter();
        if (captured.kind === 'start') {
          const session = await this.#start({ ...captured.request, admission }, publish, work);
          outcome.resolve({ kind: 'accepted', session });
        } else {
          await this.#resume({ ...captured.request, admission }, publish, work);
          outcome.resolve({ kind: 'accepted', session: null });
        }
      } catch (error) {
        outcome.resolve({ kind: work.entered ? 'unknown' : 'rejected', error });
      }
    });
    const settled = completion.then(() => work.settled()).finally(() => caller.removeEventListener('abort', abort));
    return Object.freeze({ dispatch: outcome.promise, settled, abort: async () => work.abort() });
  }

  async start(
    request: Parameters<AgentRuntimeExecution['start']>[0],
    publish: AgentRuntimePublisher,
  ) {
    return this.#start(request, publish, null);
  }

  async #start(
    request: Parameters<AgentRuntimeExecution['start']>[0],
    publish: AgentRuntimePublisher,
    nativeWork: DirectNativeExecution | null,
  ) {
    const endpoint = this.#endpoint(request);
    let established: AgentEstablishedSession | null = null;
    const establish = (result: {
      readonly agentSessionId: string;
      readonly nativeSession: AgentEstablishedSession['nativeSession'];
    }) => {
      if (established) return established;
      established = {
        agentSessionId: result.agentSessionId,
        nativeSession: result.nativeSession,
        nativeSeedReceipt: receiptForCarriedContext(
          request.carriedContext,
          result.agentSessionId,
          'user-prefix',
        ),
      };
      publish({ type: 'session', session: established });
      return established;
    };
    const command = request.carriedContext
      ? `${request.carriedContext.prefix}${request.prompt}`
      : request.prompt;
    const result = await this.runtime.startSession({
      ...executionFields(request),
      nativeWork,
      command,
      images: request.attachments,
      endpoint,
      operation: runtimeOperation(request.runId, publish),
      onSessionActivated: (session) => void establish(session),
    });
    return established ?? establish(result);
  }

  async resume(
    request: Parameters<AgentRuntimeExecution['resume']>[0],
    publish: AgentRuntimePublisher,
  ): Promise<void> {
    await this.#resume(request, publish, null);
  }

  async #resume(
    request: Parameters<AgentRuntimeExecution['resume']>[0],
    publish: AgentRuntimePublisher,
    nativeWork: DirectNativeExecution | null,
  ): Promise<void> {
    const endpoint = this.#endpoint(request);
    await this.runtime.runTurn({
      ...executionFields(request),
      nativeWork,
      agentSessionId: request.agentSessionId,
      nativeSession: request.nativeSession,
      command: request.prompt,
      images: request.attachments,
      endpoint,
      operation: runtimeOperation(request.runId, publish),
    });
  }

  async abort(agentSessionId: string, publish: AgentRuntimePublisher): Promise<boolean> {
    return this.runtime.abort(agentSessionId, publish);
  }

  isRunning(agentSessionId: string): boolean {
    return this.runtime.isRunning(agentSessionId);
  }

  runningSessions() {
    return this.runtime.getRunningSessions().map((session) => ({
      agentSessionId: session.id,
      status: session.status ?? null,
      startedAt: session.startedAt ?? null,
    }));
  }

  async prepareProjectPathUpdate(
    request: Parameters<import('@garcon/server-agent-interface').AgentProjectPathUpdates['prepare']>[0],
  ): Promise<void> {
    request.signal.throwIfAborted();
  }

  #endpoint(request: AgentRuntimeExecutionContext) {
    request.admission.signal.throwIfAborted();
    const endpoint = request.endpoint;
    if (!endpoint) {
      throw new AgentIntegrationError(
        'INVALID_ENDPOINT',
        'A compatible API provider endpoint is required',
        false,
      );
    }
    return endpoint;
  }
}

function captureLifetimeRequest(input: AgentRuntimeExecutionLifetimeRequest): AgentRuntimeExecutionLifetimeRequest {
  const source = input.request.admission;
  const { signal, markStarted } = source;
  const admission = { signal, markStarted: () => Reflect.apply(markStarted, source, []) as Promise<void> };
  if (input.kind === 'start') {
    const { admission: _admission, ...values } = input.request;
    return { kind: 'start', request: { ...structuredClone(values), admission } };
  }
  const { admission: _admission, ...values } = input.request;
  return { kind: input.kind, request: { ...structuredClone(values), admission } };
}

function executionFields(request: AgentRuntimeExecutionContext) {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
  };
}
