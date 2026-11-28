// Shared by the oracles of the turn modules: builds a turn and a session from
// recorded JSON state and reads them back as JSON, so the unit recorder can
// call functions that take the original's mutable objects.
//
// The wall clock is fixed while a recorded call runs, because these functions
// read `Date.now()` and `new Date()` directly and a recording has to repeat.

import {
  createOpenCodeTurnContext,
  type OpenCodeSession,
  type OpenCodeTurnContext,
} from "../../../../server-agents/opencode/src/agents/opencode/turn-events.ts";

export const FIXED_NOW = 1_700_000_000_012;

export function withFixedWallClock<T>(operation: () => T): T {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) {
        super(FIXED_NOW);
      } else {
        super(...(args as ConstructorParameters<typeof Date>));
      }
    }
    static override now() {
      return FIXED_NOW;
    }
  }
  const realNow = RealDate.now;
  Date.now = () => FIXED_NOW;
  globalThis.Date = FixedDate as unknown as DateConstructor;
  try {
    return operation();
  } finally {
    globalThis.Date = RealDate;
    Date.now = realNow;
  }
}

// A logger that keeps its lines, so a recording pins them.
export function recordingLogger() {
  const lines: Array<{ level: string; message: string; fields: unknown }> = [];
  const record = (level: string) => (message: string, fields?: unknown) => {
    lines.push({ level, message, fields: fields === undefined ? null : fields });
  };
  return {
    lines,
    logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
  };
}

type State = Record<string, unknown>;

export function buildTurn(state: State = {}, published: unknown[] = []) {
  const turn = createOpenCodeTurnContext(
    { runId: (state.runId as string | undefined) ?? 'run-oracle', publish: (event: unknown) => published.push(event) },
    { compaction: state.compaction === true },
  );
  // The context's own random part ID would differ between two recordings.
  turn.providerPromptPartId = (state.providerPromptPartId as string | undefined) ?? 'prt_oracle';
  if (state.providerMessageId !== undefined) turn.providerMessageId = state.providerMessageId as string | null;
  if (state.providerPromptRequestCompleted !== undefined) turn.providerPromptRequestCompleted = state.providerPromptRequestCompleted === true;
  if (state.providerSteeringDeliveryUnconfirmed !== undefined) turn.providerSteeringDeliveryUnconfirmed = state.providerSteeringDeliveryUnconfirmed === true;
  if (state.lastRetryNoticeKey !== undefined) turn.lastRetryNoticeKey = state.lastRetryNoticeKey as string | null;
  if (state.manualCompactionBoundaryPublished !== undefined) turn.manualCompactionBoundaryPublished = state.manualCompactionBoundaryPublished === true;
  for (const key of [
    'providerContinuationMessageIds', 'automaticCompactionMessageIds', 'recentEventIds',
    'providerSteeringPartIds', 'pendingSteeringMessageIds', 'observedUserMessageIds',
    'assistantMessageIds', 'publishedPartIds',
  ] as const) {
    const values = state[key];
    if (Array.isArray(values)) for (const value of values) (turn[key] as Set<string>).add(value as string);
  }
  for (const key of ['assistantTerminals', 'messageRoles', 'assistantPartTypes'] as const) {
    const entries = state[key];
    if (entries && typeof entries === 'object') {
      for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
        (turn[key] as Map<string, unknown>).set(id, value);
      }
    }
  }
  return turn;
}

export function snapshotTurn(turn: OpenCodeTurnContext): State {
  const snapshot: State = {
    providerMessageId: turn.providerMessageId,
    providerPromptPartId: turn.providerPromptPartId,
    providerPromptRequestCompleted: turn.providerPromptRequestCompleted,
    providerSteeringDeliveryUnconfirmed: turn.providerSteeringDeliveryUnconfirmed,
    lastRetryNoticeKey: turn.lastRetryNoticeKey ?? null,
    providerContinuationMessageIds: [...turn.providerContinuationMessageIds],
    automaticCompactionMessageIds: [...turn.automaticCompactionMessageIds],
    recentEventIds: [...turn.recentEventIds],
    providerSteeringPartIds: [...turn.providerSteeringPartIds],
    pendingSteeringMessageIds: [...turn.pendingSteeringMessageIds],
    observedUserMessageIds: [...turn.observedUserMessageIds],
    assistantMessageIds: [...turn.assistantMessageIds],
    assistantTerminals: Object.fromEntries(turn.assistantTerminals),
    publishedPartIds: [...turn.publishedPartIds],
    messageRoles: Object.fromEntries(turn.messageRoles),
    assistantPartTypes: Object.fromEntries(turn.assistantPartTypes),
  };
  if (turn.finalResponse !== undefined) snapshot.finalResponse = turn.finalResponse;
  return snapshot;
}

export function buildSession(state: State = {}): OpenCodeSession {
  return {
    status: (state.status as OpenCodeSession['status'] | undefined) ?? 'completed',
    aborting: state.aborting as boolean | undefined,
    chatId: (state.chatId as string | undefined) ?? 'chat-oracle',
    model: state.model as string | undefined,
    thinkingVariant: state.thinkingVariant as string | undefined,
    permissionMode: (state.permissionMode as OpenCodeSession['permissionMode'] | undefined) ?? 'default',
    directory: state.directory as string | undefined,
    startedAt: '1970-01-01T00:00:00.000Z',
    lastActivityAt: (state.lastActivityAt as number | undefined) ?? 0,
    providerWorkRequiresQuiescence: state.providerWorkRequiresQuiescence === true,
    activeSteeringDeliveries: (state.activeSteeringDeliveries as number | undefined) ?? 0,
    deferredTerminal: (state.deferredTerminal as OpenCodeSession['deferredTerminal'] | undefined) ?? null,
    pendingSteeringRevertMessageId: (state.pendingSteeringRevertMessageId as string | null | undefined) ?? null,
    turn: buildTurn((state.turn as State | undefined) ?? {}),
  };
}

export function snapshotSession(session: OpenCodeSession): State {
  return {
    status: session.status,
    aborting: session.aborting ?? null,
    chatId: session.chatId,
    model: session.model ?? null,
    thinkingVariant: session.thinkingVariant ?? null,
    permissionMode: session.permissionMode,
    directory: session.directory ?? null,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    providerWorkRequiresQuiescence: session.providerWorkRequiresQuiescence,
    activeSteeringDeliveries: session.activeSteeringDeliveries,
    deferredTerminal: session.deferredTerminal,
    pendingSteeringRevertMessageId: session.pendingSteeringRevertMessageId ?? null,
    turn: snapshotTurn(session.turn),
  };
}
