import crypto from 'node:crypto';
import { QueueExecutionAttempt } from '../../../../server/controller/chat-execution/execution-attempt.ts';
import { ExecutionOwnership } from '../../../../server/controller/chat-execution/execution-ownership.ts';
import { QueuedTurnFinalizationTracker } from '../../../../server/controller/chat-execution/turn-finalization-tracker.ts';
import type { TurnIdentity } from '../../../../server/controller/lib/turn-identity.ts';

type Step = [string, ...any[]];

function outcome<T>(run: () => T): T | { error: string } | null {
  try { return run() ?? null; }
  catch (error) { return { error: (error as Error).message }; }
}

export function attemptTrace(identity: TurnIdentity, entryId: string | null, steps: Step[]) {
  const attempt = new QueueExecutionAttempt(identity, entryId ?? undefined);
  return steps.map(([name, ...args]) => outcome(() => {
    const method = (attempt as any)[name];
    return typeof method === 'function' ? method.apply(attempt, args) : method;
  }));
}

export function ownershipTrace(ids: string[], steps: Step[]) {
  const originalUuid = crypto.randomUUID;
  let idCalls = 0;
  crypto.randomUUID = (() => ids[idCalls++] ?? 'unexpected-id') as typeof originalUuid;
  try {
    const ownership = new ExecutionOwnership();
    const direct = new Map();
    const attempts = new Map();
    const snapshots = new Map();
    const results = steps.map(([name, ...args]) => outcome(() => {
      const [chat, label, other] = args;
      switch (name) {
        case 'reserveDirect': {
          const reservation = ownership.reserveDirect(chat, other);
          direct.set(label, reservation);
          return { chatId: reservation.chatId, reservationId: reservation.reservationId };
        }
        case 'reserveTranscriptSnapshot': {
          const reservation = ownership.reserveTranscriptSnapshot(chat);
          snapshots.set(label, reservation);
          return reservation;
        }
        case 'replaceTurnWithTranscriptSnapshot': {
          const reservation = ownership.replaceTurnWithTranscriptSnapshot(chat, other);
          if (reservation) snapshots.set(label, reservation);
          return reservation;
        }
        case 'installAttempt': {
          const attempt = new QueueExecutionAttempt(other, args[3]);
          ownership.installAttempt(chat, attempt);
          attempts.set(label, attempt);
          return null;
        }
        case 'captureAttempt': attempts.set(label, ownership.attempt(chat)); return null;
        case 'attemptSettled': return attempts.get(label).isSettled;
        case 'attemptTerminalCommitted': return attempts.get(label).hasTerminalCommit;
        case 'attemptIdentity': return ownership.attempt(chat)?.identity() ?? null;
        case 'isDirectCurrent': return ownership.isDirectCurrent(direct.get(label));
        case 'releaseDirect': return ownership.releaseDirect(direct.get(label));
        case 'releaseTranscriptSnapshot': return ownership.releaseTranscriptSnapshot(snapshots.get(label));
        case 'isCurrentAttempt': return ownership.isCurrentAttempt(chat, attempts.get(label));
        case 'removeAttempt': return ownership.removeAttempt(chat, attempts.get(label));
        case 'retireAttempt': return ownership.retireAttempt(chat, attempts.get(label), other ? new Error(other) : undefined);
        case 'abortAdmission': return ownership.abortAdmission(chat, new Error(label));
        case 'beginShutdown': return ownership.beginShutdown(new Error(chat));
        case 'clearChat': return ownership.clearChat(chat, new Error(label));
        case 'admissionSignal': {
          const { signal } = direct.get(label).executionAdmission;
          return { aborted: signal.aborted, reason: signal.reason?.message ?? null };
        }
        default: return (ownership as any)[name](...args);
      }
    }));
    return { results, idCalls };
  } finally {
    crypto.randomUUID = originalUuid;
  }
}

export async function finalizationTrace(steps: Step[]) {
  const tracker = new QueuedTurnFinalizationTracker();
  const handles = new Map();
  const waiting = new Map();
  const results = [];
  for (const [name, chat, turn, argument] of steps) {
    switch (name) {
      case 'begin': results.push(outcome(() => {
        handles.set(argument, tracker.begin(chat, turn));
      })); break;
      case 'get': results.push(await tracker.get(chat, turn)); break;
      case 'capture': waiting.set(argument, tracker.get(chat, turn)); results.push(null); break;
      case 'wait': results.push(await waiting.get(argument)); break;
      case 'settle': handles.get(turn).settle(argument); results.push(null); break;
      case 'clearChat': tracker.clearChat(chat); results.push(null); break;
    }
  }
  return results;
}

export async function finalizationRetention(oldestActive: boolean) {
  const tracker = new QueuedTurnFinalizationTracker();
  const first = tracker.begin('chat', 'oldest');
  if (!oldestActive) first.settle('committed');
  for (let index = 0; index < 64; index++) tracker.begin('chat', String(index)).settle('committed');
  const wasRetained = tracker.get('chat', 'oldest') !== null;
  first.settle('not-committed');
  const priorResult = await tracker.get('chat', 'oldest');
  tracker.begin('chat', 'newest');
  return { wasRetained, priorResult, retainedAfterPrune: tracker.get('chat', 'oldest') !== null };
}
