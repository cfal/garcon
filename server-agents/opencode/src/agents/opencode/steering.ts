import type {
  AgentSteerRequest,
  AgentSteerResult,
  AgentSteerTarget,
} from '@garcon/server-agent-interface';
import { buildPromptBody } from './prompt.js';
import { withAbortableTimeout } from './request-control.js';
import type { SSEEvent } from './sse-events.js';
import {
  hasOpenCodeResultError,
  openCodeResultErrorMessage,
  throwOpenCodeResultError,
  withOpenCodeRequestScope,
  type OpenCodeRequestScope,
} from './sdk-result.js';
import {
  createOpenCodePromptPartId,
  observeOpenCodeSteeringPart,
  type OpenCodeSession,
  type OpenCodeTurnContext,
} from './turn-events.js';

interface CapturedOpenCodeSteerTarget {
  session: OpenCodeSession;
  turn: OpenCodeTurnContext;
}

interface PendingOpenCodeSteeringAcknowledgement extends CapturedOpenCodeSteerTarget {
  promise: Promise<void>;
  resolve: () => void;
}

interface OpenCodeSteeringOptions {
  requestTimeoutMs: number;
  getSession(agentSessionId: string): OpenCodeSession | undefined;
  getClient(): Promise<any>;
  runScopedRequest<T>(
    label: string,
    scope: OpenCodeRequestScope,
    operation: (signal: AbortSignal, scope: OpenCodeRequestScope) => Promise<T>,
  ): Promise<T>;
  releaseDeferredTerminal(agentSessionId: string, session: OpenCodeSession): void;
  bindOperationPart(turn: OpenCodeTurnContext, partId: string): boolean;
  unbindOperationPart(turn: OpenCodeTurnContext, partId: string): void;
}

export class OpenCodeSteeringController {
  readonly #targets = new WeakMap<AgentSteerTarget, CapturedOpenCodeSteerTarget>();
  readonly #acknowledgements = new Map<string, PendingOpenCodeSteeringAcknowledgement>();

  constructor(private readonly options: OpenCodeSteeringOptions) {}

  captureTarget(agentSessionId: string): AgentSteerTarget | null {
    const session = this.options.getSession(agentSessionId);
    if (
      !session
      || session.turn.compaction
      || session.status !== 'running'
      || session.aborting
      || !session.turn.providerMessageId
    ) return null;
    const target = Object.freeze({});
    this.#targets.set(target, { session, turn: session.turn });
    return target;
  }

  async steer(request: AgentSteerRequest): Promise<AgentSteerResult> {
    const captured = request.target ? this.#targets.get(request.target) : undefined;
    if (!captured) return rejectedSteer('no-active-turn', 'No active OpenCode turn');
    this.#targets.delete(request.target!);

    const session = this.options.getSession(request.agentSessionId);
    if (session !== captured.session || session?.turn !== captured.turn) {
      return rejectedSteer('turn-changed', 'The active OpenCode turn changed');
    }
    if (
      session.status !== 'running'
      || session.aborting
      || session.chatId !== request.chatId
    ) return rejectedSteer('no-active-turn', 'No active OpenCode turn');
    if (!request.input.trim()) {
      return rejectedSteer('invalid-input', 'OpenCode rejected the steering input');
    }

    const client = await this.options.getClient();
    if (
      this.options.getSession(request.agentSessionId) !== session
      || session.status !== 'running'
      || session.aborting
      || session.turn !== captured.turn
    ) return rejectedSteer('turn-changed', 'The active OpenCode turn changed');

    const turn = captured.turn;
    const partId = createOpenCodePromptPartId();
    const promptBody = buildPromptBody(request.input, session.model, partId, [], session.thinkingVariant);
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const pending = {
      session,
      turn,
      promise: acknowledgement,
      resolve: acknowledge,
    } satisfies PendingOpenCodeSteeringAcknowledgement;
    if (!this.options.bindOperationPart(turn, partId)) {
      return rejectedSteer('turn-changed', 'The active OpenCode turn changed');
    }
    turn.providerSteeringPartIds.add(partId);
    this.#acknowledgements.set(partId, pending);
    session.activeSteeringDeliveries += 1;
    let attempted = false;
    let preserveCorrelation = false;

    try {
      await request.prepareDelivery();
      attempted = true;
      let result: unknown;
      try {
        // OpenCode's own app submits promptAsync while a session is busy to steer its active
        // loop; the caller-owned part ID supplies the durable delivery acknowledgement.
        // https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L311-L328
        result = await this.options.runScopedRequest(
          'OpenCode steering submit',
          { directory: session.directory },
          (signal, requestScope) => client.session.promptAsync(withOpenCodeRequestScope({
            sessionID: request.agentSessionId,
            ...promptBody,
          }, requestScope), { signal }),
        );
      } catch {
        preserveCorrelation = true;
        session.providerWorkRequiresQuiescence = true;
        return failedSteer('unknown', 'OpenCode steering delivery could not be confirmed');
      }

      if (hasOpenCodeResultError(result)) return classifySteerRejection(result);
      preserveCorrelation = true;
      try {
        await withAbortableTimeout(
          () => pending.promise,
          this.options.requestTimeoutMs,
          'OpenCode steering acknowledgement',
        );
      } catch {
        session.providerWorkRequiresQuiescence = true;
        return failedSteer('unknown', 'OpenCode steering delivery could not be confirmed');
      }
      return { kind: 'accepted' };
    } catch (error) {
      if (!attempted) throw error;
      preserveCorrelation = true;
      session.providerWorkRequiresQuiescence = true;
      return failedSteer('unknown', 'OpenCode steering delivery could not be confirmed');
    } finally {
      if (this.#acknowledgements.get(partId) === pending) {
        this.#acknowledgements.delete(partId);
      }
      if (!preserveCorrelation) {
        turn.providerSteeringPartIds.delete(partId);
        this.options.unbindOperationPart(turn, partId);
      }
      this.#releaseDelivery(request.agentSessionId, session, turn);
    }
  }

  observeAcknowledgement(session: OpenCodeSession, event: SSEEvent): void {
    const partId = observeOpenCodeSteeringPart(session, event);
    if (!partId) return;
    const pending = this.#acknowledgements.get(partId);
    if (!pending || pending.session !== session || pending.turn !== session.turn) return;
    this.#acknowledgements.delete(partId);
    pending.resolve();
  }

  stagePendingCleanup(session: OpenCodeSession): void {
    const earliest = [...session.turn.pendingSteeringMessageIds].sort()[0];
    if (
      earliest
      && (!session.pendingSteeringRevertMessageId
        || earliest < session.pendingSteeringRevertMessageId)
    ) session.pendingSteeringRevertMessageId = earliest;
  }

  async removeUnconsumed(
    client: any,
    agentSessionId: string,
    session: OpenCodeSession,
    scope: OpenCodeRequestScope,
  ): Promise<void> {
    const messageId = session.pendingSteeringRevertMessageId;
    if (!messageId) return;
    const result = await this.options.runScopedRequest(
      'OpenCode unconsumed steering revert',
      scope,
      (signal, requestScope) => client.session.revert(
        withOpenCodeRequestScope({ sessionID: agentSessionId, messageID: messageId }, requestScope),
        { signal },
      ),
    );
    throwOpenCodeResultError(result, 'OpenCode unconsumed steering revert failed');
    session.pendingSteeringRevertMessageId = null;
  }

  #releaseDelivery(
    agentSessionId: string,
    session: OpenCodeSession,
    turn: OpenCodeTurnContext,
  ): void {
    session.activeSteeringDeliveries = Math.max(0, session.activeSteeringDeliveries - 1);
    if (session.activeSteeringDeliveries > 0 || session.turn !== turn) return;
    this.options.releaseDeferredTerminal(agentSessionId, session);
  }
}

function rejectedSteer(
  reason: Extract<AgentSteerResult, { kind: 'rejected' }>['reason'],
  message: string,
): AgentSteerResult {
  return { kind: 'rejected', reason, message };
}

function failedSteer(
  outcome: Extract<AgentSteerResult, { kind: 'failed' }>['outcome'],
  message: string,
): AgentSteerResult {
  return { kind: 'failed', outcome, message };
}

function classifySteerRejection(result: unknown): AgentSteerResult {
  const message = openCodeResultErrorMessage(result, 'OpenCode rejected the steering input');
  if (/empty input|input.*(?:too large|limit|maximum)|invalid input/i.test(message)) {
    return rejectedSteer('invalid-input', 'OpenCode rejected the steering input');
  }
  if (/no active|not running|session.*(?:idle|not found)/i.test(message)) {
    return rejectedSteer('no-active-turn', 'No active OpenCode turn');
  }
  return rejectedSteer('provider-rejected', 'OpenCode rejected the steering input');
}
