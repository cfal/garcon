import crypto from 'node:crypto';
import { AgentCallError, AgentIntegrationError } from '../../../../server-agents/interface/src/index.ts';
import { AcceptedInputHandler } from '../../../../server/controller/chat-execution/accepted-input-handler.ts';
import { AcceptedInputTranscript } from '../../../../server/controller/chat-execution/accepted-input-transcript.ts';
import { emptyStoredChatExecutionControl } from '../../../../server/controller/chat-execution/control-state.ts';
import { ExecutionOwnership } from '../../../../server/controller/chat-execution/execution-ownership.ts';
import { QueueExecutionAttempt } from '../../../../server/controller/chat-execution/execution-attempt.ts';
import { SteerDeliveryError } from '../../../../server/controller/chat-execution/steering-errors.ts';
import { interruptAgentTurn, settleAgentTurn } from '../../../../server/controller/chat-execution/turn-terminal-settlement.ts';
import { QueueEntryMutationError } from '../../../../server/controller/chat-execution/types.ts';
import {
  dispatchFailureDetail, executionSetupFailure, isLostLaunchReply, publicDispatchFailure,
} from '../../../../server/controller/agents/runtime-router-errors.ts';
import { CommandLedger } from '../../../../server/controller/commands/command-ledger.ts';
import { projectAgentTurnReceipt } from '../../../../server/controller/commands/agent-turn-receipt-projector.ts';
import { ChatCommandSettlement } from '../../../../server/controller/commands/chat-command-settlement.ts';
import { DomainError } from '../../../../server/common/domain-error.ts';

type Step = [string, ...any[]];

const CHAT = 'chat';
const TURN = 'turn';
const ENTRY = 'entry';
const REQUEST = 'request';
const COMMAND = { key: 'agent-run:chat:request', chatId: CHAT, turnId: TURN, clientRequestId: REQUEST, entryId: ENTRY };

function control() {
  return emptyStoredChatExecutionControl('server');
}

async function withClock<T>(run: () => Promise<T>): Promise<T> {
  const originalDate = globalThis.Date;
  globalThis.Date = class extends originalDate {
    constructor() { super(60_123); }
    static now() { return 60_123; }
  } as typeof Date;
  try {
    return await run();
  } finally {
    globalThis.Date = originalDate;
  }
}

function errorShape(error: any) {
  return {
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    outcome: error.deliveryOutcome ?? error.outcome ?? null,
  };
}

function decodeError(error: any) {
  switch (error.kind) {
    case 'domain': return new DomainError(error.code, error.message, error.status);
    case 'mutation': return new QueueEntryMutationError(error.code, error.message, control());
    case 'agent-call': return new AgentCallError(error.outcome, error.message);
    case 'integration': return new AgentIntegrationError(error.code, error.message);
    case 'steer': return new SteerDeliveryError(new Error(error.message), error.outcome);
    default: return new Error(error.message);
  }
}

async function outcome<T>(run: () => T | Promise<T>) {
  try {
    return await run() ?? null;
  } catch (error) {
    return { error: errorShape(error) };
  }
}

function traced(result: unknown, effects: unknown[]) {
  const wire = JSON.stringify({ result, effects });
  return { ...JSON.parse(wire), wire };
}

export function acceptedInputTranscriptTrace(steps: Step[], inserted: boolean) {
  return withClock(async () => {
    const effects: unknown[] = [];
    const transcript = new AcceptedInputTranscript({
      hasMatchingInput(chat, message) { effects.push(['match', chat, message]); return true; },
      async admitInput(chat, message, opts) { effects.push(['direct', chat, message, opts.clientRequestId]); return { inserted }; },
      admitQueuedInput(chat, message, opts) { effects.push(['queued', chat, message, opts.clientRequestId]); return { inserted }; },
      discardPreparedInput(chat, id) { effects.push(['discard', chat, id]); },
    });
    const result = [];
    for (const [name, ...args] of steps) {
      result.push(await outcome(() => (transcript as any)[name](CHAT, ...args)));
    }
    return traced(result, effects);
  });
}

export function commandSettlementTrace(commandType: string, steps: Step[]) {
  return withClock(async () => {
    const ledger = new CommandLedger();
    const settle = new ChatCommandSettlement(ledger);
    const record = (await ledger.accept({
      commandType, chatId: CHAT, clientRequestId: REQUEST, turnId: commandType === 'agent-run' ? TURN : undefined, payload: { content: 'prompt', count: 1.0 },
    })).record;
    const command = { ...COMMAND, key: record.key };
    const result = [];
    for (const [name, ...args] of steps) {
      result.push(await outcome(async () => {
        switch (name) {
          case 'project': return projectAgentTurnReceipt((await ledger.getRecord(record.key))!);
          case 'record': return await ledger.getRecord(record.key);
          case 'update': return await ledger.update(record.key, args[0]);
          case 'result': return await ledger.setTurnResult(CHAT, TURN, args[0]);
          case 'publish': return await ledger.markPublicTerminal(CHAT, TURN, args[0]);
          case 'terminal': return await ledger.settleTerminal(record.key, args[0]);
          case 'markPreScheduleFailure':
            return await settle.markPreScheduleFailure(command, { error: decodeError(args[0]), retryable: args[1], preserveForkPreparation: args[2] });
          case 'settleQueueMutationFailure': case 'settleOperationFailure': case 'settleSteerFailure':
            return await (settle as any)[name](command, decodeError(args[0]), ...args.slice(1));
          default: return await (settle as any)[name](command, ...args);
        }
      }));
    }
    return traced(result, []);
  });
}

export function runtimeFailureTrace(error: unknown) {
  const value = decodeError(error);
  return {
    lostLaunch: isLostLaunchReply(value),
    setup: errorShape(executionSetupFailure(value)),
    detail: dispatchFailureDetail(value),
    public: publicDispatchFailure(value),
  };
}

export async function terminalSettlementTrace(options: any) {
  const owner = new ExecutionOwnership();
  const attempt = new QueueExecutionAttempt({ turnId: TURN }, options.entry ? ENTRY : undefined);
  const admission = options.noAttempt ? null : owner.installAttempt(CHAT, attempt);
  if (options.terminal) owner.markRunTerminalCommitted(CHAT, TURN);
  const effects: unknown[] = [];
  const retire = (chat: string, target: QueueExecutionAttempt, reason?: Error) => {
    effects.push(['retire', chat, target.identity().turnId, reason?.message ?? null]);
    owner.retireAttempt(chat, target, reason);
  };
  const result = await outcome(async () => {
    if (options.mode === 'interrupt') return await interruptAgentTurn({
      ownership: owner,
      async abortSession(chat) {
        effects.push(['abort', chat, admission?.signal.aborted ?? null]);
        if (options.error) throw decodeError(options.error);
        if (options.stale) owner.retireAttempt(CHAT, attempt);
        return Boolean(options.acknowledged);
      },
      retire,
    }, CHAT);
    return await settleAgentTurn({
      ownership: owner,
      control: { async pauseAfterFailure(chat: string, cause: unknown) { effects.push(['pause', chat, cause]); } } as any,
      workingDirectory: options.working ? {
        async settle(chat, turn, isCurrent) {
          effects.push(['working', chat, turn.turnId, isCurrent()]);
          if (options.stale) owner.retireAttempt(CHAT, attempt);
          if (options.error) throw decodeError(options.error);
          return { kind: 'settled' };
        },
      } : undefined,
      executionPolicy(chat) { effects.push(['policy', chat]); return options.policy ?? 'conversation'; },
      retire,
      async checkIdle(chat) { effects.push(['idle', chat]); },
    }, CHAT, { turnId: options.wrong ? 'other' : TURN }, options.outcome ?? 'finished');
  });
  effects.push(['final', owner.hasAttempt(CHAT), admission?.signal.aborted ?? null]);
  return traced(result, effects);
}

export async function acceptedInputHandlerTrace(spec: any) {
  const effects: unknown[] = [];
  const tasks: Promise<void>[] = [];
  let now = spec.start ?? 19_000;
  let next = 0;
  const originalPerformance = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
  const originalUuid = crypto.randomUUID;
  crypto.randomUUID = (() => `id-${++next}`) as typeof originalUuid;
  const admission = new AbortController();
  const fail = (name: string) => { if (spec.fail?.[name]) throw decodeError(spec.fail[name]); };
  const log = (name: string, ...fields: unknown[]) => {
    effects.push([name, ...fields]);
    fail(name);
    if (name === spec.abortAfter) admission.abort(new Error('admission cancelled'));
  };
  const revision = (input: any) => [input.entryId, input.expectedRevision, input.expectedReorderRevision];
  const entry = { id: ENTRY, content: 'queued guidance', images: [], revision: 2, status: 'steering' };
  const settlement = {
    async markScheduled(_command: unknown, turn: string) { log('scheduled', turn); },
    async markPreScheduleFailure(_command: unknown, failure: any) {
      log('pre-failed', errorShape(failure.error), failure.retryable, failure.preserveForkPreparation ?? false);
    },
    async settleQueueMutation(_command: unknown, entry: string) { log('queue-done', entry); },
    async settleQueueMutationFailure(_command: unknown, error: unknown) { log('queue-failed', errorShape(error)); },
    async settleSteerSuccess(_command: unknown, turn: string) { log('steer-done', turn); },
    async settleSteerFailure(_command: unknown, error: unknown, disposition?: string) { log('steer-failed', errorShape(error), disposition ?? null); },
    async settleOperationFailure(_command: unknown, error: unknown) { log('operation-failed', errorShape(error)); },
    async settleDuplicateInput() { log('duplicate'); },
  };
  const reservation = { chatId: CHAT, reservationId: 'reservation', executionAdmission: { signal: admission.signal } };
  const handler = new AcceptedInputHandler({
    controls: {
      async create(_chat: string, input: any, deadline: number | null) {
        log('create', input.content, input.submission, deadline ?? null);
        return { entryId: ENTRY, entry: null, duplicate: false, control: control() };
      },
      async replace(_chat: string, id: string, content: string, revision: number) {
        log('replace', id, content, revision);
        return { entryId: ENTRY, entry: null, duplicate: false, control: control() };
      },
      async delete(_chat: string, id: string) {
        log('delete', id);
        return { entryId: ENTRY, control: control(), duplicate: false };
      },
      async move(_chat: string, input: any, command: any) {
        log('move', input.entryId, input.targetEntryId, input.placement, input.expectedReorderRevision,
          input.expectedSourceRevision, input.expectedTargetRevision, command.key);
        return { entryId: ENTRY, duplicate: false, rebased: false, control: control() };
      },
      async createSteer(_chat: string, content: string, _command: unknown, submission: unknown) {
        log('create-steer', content, submission);
        return { entryId: ENTRY, control: control(), duplicate: false };
      },
      async markSteer(_chat: string, input: any) { log('mark-steer', ...revision(input)); return control(); },
      async reserveSteer(_chat: string, input: any) { log('reserve-steer', ...revision(input)); return { entry }; },
      async consumeSteer(_chat: string, id: string) { log('consume', id); return control(); },
      async releaseSteer(_chat: string, id: string) { log('release-steer', id); return control(); },
      async requeueAndPause(_chat: string, id: string, kind: string) { log('requeue', id, kind); return control(); },
      async read() {
        log('read');
        const current = control();
        if (spec.mode === 'recover') current.entries.push(entry as any);
        if (spec.blocked) current.pause = { id: 'pause', kind: 'manual', pausedAt: 'now' };
        return current;
      },
    } as any,
    coordinator: {
      requestDrain(chat, context) { log('drain', chat, context); },
      reserveDirect(chat, turn) { log('reserve-direct', chat, turn.turnId); return reservation as any; },
      checkpoint() { log('checkpoint'); admission.signal.throwIfAborted(); },
      hasMatchingInput(_chat, content, options) { log('match', content, options.userMessagePresentation ?? null); return Boolean(spec.duplicate); },
      async admitInput(_chat, content, options) { log('admit', content, options.userMessagePresentation ?? null); return spec.inserted ?? true; },
      discardPreparedInput(_chat, message) { log('discard', message); },
      async releaseDirect() { log('release-direct'); },
      async runDirect(_reservation, content, options, dispatch, beforeFailure) {
        try {
          log('run', content, options.turnId, 'userMessagePresentation' in options);
          if (dispatch) await dispatch(reservation.executionAdmission as any);
        } catch (error) {
          if (beforeFailure) await beforeFailure(error);
          throw error;
        }
      },
      trackDispatch(task) { log('track'); tasks.push(task); },
      async steer(_chat, content, providerContent, opts, target, before, presentation) {
        log('steer', content, providerContent, opts.clientMessageId, target.identity.turnId, presentation ?? null);
        await before(target.identity.turnId);
        return { turnId: target.identity.turnId, duplicate: Boolean(spec.steerDuplicate) };
      },
    },
    projectAdmission: { async assertAvailable(_chat, deadline) { log('project', deadline ?? null); } },
  });
  try {
    const input = { command: COMMAND, settlement, content: 'new work', clientMessageId: 'message', transcriptViewId: 'view', admissionDeadline: spec.deadline ?? null };
    const result = await outcome(() => {
      switch (spec.mode) {
        case 'enqueue': return handler.enqueue({ ...input, images: [], excludedResendOrdinals: spec.excluded });
        case 'replace': return handler.replace({ ...input, expectedRevision: 2 });
        case 'delete': return handler.delete(input);
        case 'move': return handler.move({
          ...input, targetEntryId: 'target', placement: 'before', expectedSourceRevision: 2,
          expectedReorderRevision: 4, expectedTargetRevision: 3,
        });
        case 'enqueueSteer': return handler.enqueueSteer(input);
        case 'markQueueEntrySteer': return handler.markQueueEntrySteer({ ...input, expectedRevision: 2, expectedReorderRevision: 4 });
        case 'recover': return handler.recoverQueueEntrySteer(CHAT, ENTRY);
        case 'steer': case 'steerQueueEntry':
          return handler[spec.mode as 'steer']({
            ...input, providerContent: 'resolved context', expectedRevision: 2, expectedReorderRevision: 4,
            target: { attempt: {} as any, identity: { turnId: 'current' }, providerTarget: null, deadline: null },
            userMessagePresentation: spec.presentation,
          });
        case 'scheduleOperation': return handler.scheduleOperation({
          ...input,
          dispatch: async () => { log('dispatch'); },
        });
        default: return handler[spec.mode as 'schedule']({
          ...input, options: { turnId: TURN, clientMessageId: 'message', clientRequestId: REQUEST },
          userMessagePresentation: spec.presentation,
          preparation: spec.preparation === undefined ? undefined : {
            operation: 'fork-run', async prepare(ctx) { log('prepare'); ctx.assertAdmissionActive(); now += spec.preparation; },
            async compensate() { log('compensate'); },
          },
          dispatch: spec.dispatch ? async () => { log('dispatch'); } : undefined,
        });
      }
    });
    await Promise.all(tasks);
    return traced(result, effects);
  } finally {
    if (originalPerformance) Object.defineProperty(performance, 'now', originalPerformance);
    else Reflect.deleteProperty(performance, 'now');
    crypto.randomUUID = originalUuid;
  }
}
