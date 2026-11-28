import crypto from 'node:crypto';
import { AgentCallError } from '../../../../server-agents/interface/src/index.ts';
import { DomainError, ProjectUnavailableError } from '../../../../server/common/domain-error.ts';
import { ExecutorSessionLostError } from '../../../../server/common/executor-disconnect.ts';
import { KeyedPromiseLock } from '../../../../server/common/keyed-lock.ts';
import { ChatExecutionControlOperations } from '../../../../server/controller/chat-execution/chat-execution-control-operations.ts';
import { InMemoryChatExecutionControlRepository } from '../../../../server/controller/chat-execution/chat-execution-control-repository.ts';
import { ControlInputDelivery } from '../../../../server/controller/chat-execution/control-input-delivery.ts';
import { QueueExecutionAttempt } from '../../../../server/controller/chat-execution/execution-attempt.ts';
import { QueueDrainer } from '../../../../server/controller/chat-execution/queue-drainer.ts';
import { ExecutionOwnership } from '../../../../server/controller/chat-execution/execution-ownership.ts';
import { QueuedSteerDelivery } from '../../../../server/controller/chat-execution/queued-steer-delivery.ts';
import { SteerInputDelivery } from '../../../../server/controller/chat-execution/steer-input-delivery.ts';

const CHAT = 'chat-1';
const TURN = 'turn-1';
const VIEW = 'view-1';
const TARGET = { executorId: 'executor', instanceId: 'instance', integrationId: 'agent', kind: 'steer-target', id: 'target' } as const;
const OPTIONS = { clientRequestId: 'request', clientMessageId: 'message', transcriptViewId: VIEW };
const QUESTION = {
  questionId: 'question', question: 'Which environment?', answer: 'Staging',
  source: { chatId: CHAT, transcriptViewId: VIEW, ordinal: 1 },
};
const IMAGES = [{ data: 'data:image/png;base64,AAAA', name: 'screen.png', mimeType: 'image/png' }];

function failure(error: any) {
  return { error: { name: error.name, code: error.code ?? null, message: error.message, outcome: error.outcome ?? null, status: error.status ?? null } };
}

async function outcome(run: () => unknown) {
  try { return await run() ?? null; }
  catch (error) { return failure(error); }
}

async function deterministic<T>(run: () => Promise<T>): Promise<T> {
  const oldDate = globalThis.Date;
  const oldUUID = crypto.randomUUID;
  let next = 0;
  globalThis.Date = class extends oldDate {
    constructor() { super(60_123); }
    static now() { return 60_123; }
  } as typeof Date;
  crypto.randomUUID = (() => `id-${++next}`) as typeof oldUUID;
  try { return await run(); }
  finally { globalThis.Date = oldDate; crypto.randomUUID = oldUUID; }
}

export function steerDeliveryTrace(spec: any) {
  return deterministic(async () => {
    const effects: unknown[] = [];
    const ownership = new ExecutionOwnership();
    const attempt = new QueueExecutionAttempt({ turnId: TURN, clientRequestId: 'owner' });
    if (!spec.noAttempt) ownership.installAttempt(CHAT, attempt);
    const delivery = new SteerInputDelivery({
      ownership,
      isShuttingDown: () => Boolean(spec.shutdown),
      turnRunner: {
        async captureSteerTarget(chat, deadline) {
          effects.push(['capture', chat, deadline ?? null]);
          if (spec.noTarget) return null;
          if (spec.failCapture) throw new Error('target unavailable');
          return TARGET;
        },
        async steerInput(chat, input, options, target, prepare, deadline) {
          effects.push(['provider', chat, input, options.clientRequestId, options.clientMessageId, target?.id ?? null, deadline ?? null]);
          if (spec.rejection) return { kind: 'rejected', reason: spec.rejection, message: 'rejected' };
          if (spec.preparation !== false) {
            if (spec.settleInProvider) attempt.markSettled();
            await prepare();
            effects.push(['prepared']);
          }
          if (spec.agentError) throw new AgentCallError(spec.agentError, 'send failed');
          if (spec.sessionLost) throw new ExecutorSessionLostError(spec.sessionLost, 'send failed');
          if (spec.failure) return { kind: 'failed', outcome: spec.failure, message: 'send failed' };
          return { kind: 'accepted' };
        },
      } as any,
      async admitInput(chat, content, options) {
        effects.push(['admit', chat, content, options.clientMessageId, options.turnId, options.commandType, options.questionReply ?? null]);
        return spec.inserted !== false;
      },
      discardPreparedInput(chat, key) { effects.push(['discard', chat, key]); },
    });
    const result = await outcome(async () => {
      const target = spec.control
        ? await delivery.captureControlTarget(CHAT, spec.deadline ?? null)
        : await delivery.captureTarget(CHAT, spec.deadline ?? null);
      if (!target) return null;
      if (spec.control) {
        if (spec.captureOnly) return { turnId: target.identity.turnId, providerTarget: target.providerTarget };
        return await delivery.deliverControl(CHAT, 'guidance', VIEW, target);
      }
      return await delivery.deliver(CHAT, 'guidance', 'resolved guidance', {
        ...OPTIONS, questionReply: spec.question ? QUESTION : undefined,
      }, target, async (turnId) => {
        effects.push(['registered', turnId]);
        if (spec.settleAfterAdmit) attempt.markSettled();
      });
    });
    return { result, effects };
  });
}

export async function controlDeliveryTrace(spec: any) {
  const effects: unknown[] = [];
  const abort = new AbortController();
  const waited = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  let before: unknown = null;
  const delivery = new ControlInputDelivery({
    async captureTarget(chat) {
      effects.push(['capture', chat]);
      if (spec.missingTarget) return null;
      return {
        attempt: { waitUntilSettled() {
          waited.resolve();
          return spec.wait ? settled.promise : Promise.resolve();
        } } as any,
        identity: { turnId: spec.successor ? 'turn-2' : TURN },
        providerTarget: spec.noProvider ? null : TARGET,
        deadline: null,
      };
    },
    async deliverSteer(chat, content, view, target) {
      effects.push(['steer', chat, content, view, target.identity.turnId]);
      if (spec.steerError) throw new DomainError(spec.steerError, spec.steerError, 409);
    },
    async scheduleRun(chat, content, view, onReserved) {
      effects.push(['run', chat, content, view]);
      if (spec.runError) throw new DomainError(spec.runError, spec.runError, 409);
      onReserved('control-turn');
    },
  });
  const operation = outcome(() => delivery.deliver(CHAT, 'control', VIEW,
    spec.noEmitter ? null : TURN, abort.signal, (turn) => effects.push(['reserved', turn])));
  if (spec.wait) {
    await waited.promise;
    before = effects.slice();
    if (spec.wait === 'abort') abort.abort(new Error('chat deleted'));
    else settled.resolve();
  }
  return { result: await operation, before, effects };
}

export function queuedDeliveryTrace(spec: any) {
  return deterministic(async () => {
    const effects: unknown[] = [];
    const tasks: Promise<void>[] = [];
    const ownership = new ExecutionOwnership();
    const install = (turn: string) => {
      const attempt = new QueueExecutionAttempt({ turnId: turn, clientRequestId: 'owner' });
      ownership.installAttempt(CHAT, attempt);
      return attempt;
    };
    let attempt = install(TURN);
    let capture = 0;
    let admitted = 0;
    let resolved = 0;
    let refuse = Boolean(spec.refuse);
    let targetReady = spec.noProvider !== true;
    let observe = false;
    const locks = new KeyedPromiseLock();
    const repository = new InMemoryChatExecutionControlRepository('server');
    let delivery: QueuedSteerDelivery;
    const controls = new ChatExecutionControlOperations(repository, {
      runExclusive: (chat, op) => locks.runExclusive(chat, op),
      chatExists: () => true,
      unsettledQueueReceiptKeys: () => new Set(),
      publish: (chat, control) => { if (observe) delivery.observe(chat, control); },
      inputAccepted: () => {},
    }, { assertAvailable: async () => {} }, { assertSupported: () => {} });
    const steer = new SteerInputDelivery({
      ownership, isShuttingDown: () => false, discardPreparedInput: () => {},
      turnRunner: {
        async captureSteerTarget(_chat, deadline) {
          effects.push(['capture', deadline]);
          capture += 1;
          if (spec.failCapture) throw new Error('capture failed');
          if (spec.rerun === 'capture' && capture === 1) {
            delivery.request(CHAT);
            return null;
          }
          if (spec.settleInCapture) attempt.markSettled();
          return targetReady ? TARGET : null;
        },
        async steerInput(_chat, input, _options, _target, prepare, deadline) {
          await prepare();
          effects.push(['provider', input, deadline]);
          return spec.rejectAfterAdmission ? { kind: 'rejected', reason: 'turn-not-steerable', message: 'not steerable' } : { kind: 'accepted' };
        },
      } as any,
      async admitInput(_chat, content, opts) {
        admitted += 1;
        effects.push(['admit', content, opts.clientMessageId, opts.transcriptViewId, opts.turnId]);
        if (refuse) {
          if (admitted >= 3) targetReady = false;
          throw new DomainError('STALE_TRANSCRIPT_VIEW', 'The transcript view changed', 409);
        }
        return true;
      },
    });
    delivery = new QueuedSteerDelivery({
      controls, steerInput: steer, canDeliver: () => true,
      requestDrain(_chat, why) { effects.push(['drain', why]); },
      trackTask(task) { tasks.push(task); },
      async resolveContent(input) {
        effects.push(['resolve', input.content]);
        resolved += 1;
        if (spec.pauseWhileResolving) await controls.pause(CHAT);
        if (spec.rerun === 'failed-resolve' && resolved === 1) {
          delivery.request(CHAT);
          throw new Error('resolver failed');
        }
        return spec.context ? input.content + '\n\nresolved context' : input.content;
      },
    });
    if (spec.future) await controls.create(CHAT, { content: 'future turn', images: spec.images ? IMAGES : [] });
    for (let index = 1; index <= (spec.entries ?? 1); index++) {
      await controls.createSteer(CHAT, index === 1 ? 'first guidance' : 'second guidance',
        { key: `steer-${index}`, entryId: `steer-${index}` },
        spec.noSubmission ? undefined : { clientMessageId: `message-${index}`, transcriptViewId: VIEW });
    }
    if (spec.paused) await controls.pause(CHAT);
    observe = Boolean(spec.observe);
    if (observe) delivery.observe(CHAT, repository.load(CHAT));
    const run = async () => {
      delivery.request(CHAT);
      while (tasks.length) await tasks.shift();
    };
    const snapshot = async () => {
      const control = await controls.read(CHAT);
      return {
        entries: control.entries.map((entry) => [entry.content, entry.kind, entry.status, entry.images]),
        dispatched: control.recentlyDispatched.map((entry) => entry.entryId),
        pause: control.pause?.kind ?? null,
      };
    };
    await run();
    const before = await snapshot();
    if (spec.resume) {
      const paused = await controls.read(CHAT);
      await controls.resume(CHAT, paused.pause!.id);
      await run();
    }
    if (refuse && spec.nextTurn) {
      delivery.retry(CHAT);
      await run();
      ownership.removeAttempt(CHAT, attempt);
      attempt = install('turn-2');
      refuse = false;
      await run();
    }
    return { before, after: await snapshot(), effects };
  });
}

export function queueDrainerTrace(spec: any) {
  return deterministic(async () => {
    const effects: unknown[] = [];
    const owner = new ExecutionOwnership();
    owner.beginDrain(CHAT);
    let available = true;
    let locked = false;
    let started: string | undefined;
    let attachmentCheck = false;
    const late = Promise.withResolvers<void>();
    const lateObserved = Promise.withResolvers<void>();
    const admission = {
      assertSupported(_chat: string, images: any[]) {
        if (!attachmentCheck) return;
        effects.push(['attachments', locked, images]);
        if (spec.rejectAttachments) {
          throw new DomainError('UNSUPPORTED_AGENT', 'Attachments unsupported', 422);
        }
        if (spec.retryAttachments) {
          throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor unavailable', 503, true);
        }
      },
    };
    const repository = new InMemoryChatExecutionControlRepository('server');
    const locks = new KeyedPromiseLock();
    const controls = new ChatExecutionControlOperations(repository, {
      runExclusive: (chat, op) => locks.runExclusive(chat, op), chatExists: () => true,
      unsettledQueueReceiptKeys: () => new Set(), publish() {}, inputAccepted() {},
    }, { assertAvailable: async () => {} }, admission);
    if (spec.controlInput || spec.controlOnly) {
      await controls.enqueueControl(CHAT, {
        content: 'control input', transcriptViewId: VIEW, createdAt: 'provided-time',
        receipt: { title: 'Inter-agent message', content: 'message', detail: { type: 'inter-agent-message-received', fromChatId: null } },
      });
    }
    if (!spec.empty && !spec.controlOnly) {
      await controls.create(CHAT, {
        content: spec.slash ? '/blocked' : 'queued input', images: spec.images ? IMAGES : [],
        submission: { clientMessageId: 'message-1', transcriptViewId: VIEW, excludedResendOrdinals: [1, 3] },
      });
      if (spec.second) await controls.create(CHAT, { content: 'later', images: [] });
    }
    if (spec.paused) await controls.pause(CHAT);
    if (spec.steering) {
      const current = repository.load(CHAT), entry = current.entries[0]!;
      await controls.reserveSteer(CHAT, { entryId: entry.id, expectedRevision: entry.revision, expectedReorderRevision: current.reorderRevision });
    }
    attachmentCheck = true;
    const dequeue = controls.dequeueNextTurn.bind(controls);
    if (spec.failRemoval) {
      controls.dequeueNextTurn = async (chat, admit) => {
        admit({ kind: 'user', entry: repository.load(chat).entries[0]! });
        throw new Error('queue removal failed');
      };
    }
    const selected = (options: any) => [
      options.model, options.clientRequestId, options.clientMessageId, options.turnId, options.transcriptViewId ?? null,
      options.excludedResendOrdinals ?? null, options.images ?? null, options.createdAt,
    ];
    const drainer = new QueueDrainer({
      ownership: owner,
      controls,
      turnRunner: {
        isChatRunning: () => false,
        async runAgentTurn(_chat, content, options) {
          effects.push(['provider', locked, content, selected(options)]);
          const attempt = owner.attempt(CHAT)!;
          if (spec.providerFailure) {
            if (spec.terminalCommitted) owner.markRunTerminalCommitted(CHAT, options.turnId!);
            throw new Error('provider rejected');
          }
          owner.retireAttempt(CHAT, attempt);
          if (spec.lateFailure) {
            await late.promise;
            effects.push(['late-rejection-observed']);
            lateObserved.resolve();
            throw new Error('late provider rejection');
          }
        },
      } as any,
      getDrainOptions: () => { effects.push(['selection', locked]); return { model: 'selected-model' }; },
      async runSelectionAdmissionExclusive(_chat, operation) {
        effects.push(['lock']);
        locked = true;
        if (spec.offlineInSelection) available = false;
        try { return await operation(); }
        finally { locked = false; effects.push(['unlock']); }
      },
      projectAdmission: { async assertAvailable(_chat, deadline) {
        effects.push(['project', deadline]);
        if (spec.stopDuringProject) owner.enterManualStop(CHAT);
        if (spec.clearDuringProject) await controls.clear(CHAT);
        if (spec.unavailable) throw new ProjectUnavailableError('/work/missing', 'not-found');
      } },
      attachmentAdmission: admission,
      callbacks: {
        canDispatch: () => available,
        isShuttingDown: () => spec.shutdownAfterInstall && owner.hasAttempt(CHAT),
        registerQueued(_chat, content, options) {
          effects.push(['registered', locked, content, selected(options)]);
          if (spec.slash && content === '/blocked') {
            throw new DomainError('PREAMBLE_SLASH_COMMAND_BLOCKED', 'Opening slash blocked', 422);
          }
          return !spec.duplicate;
        },
        appendControlReceipt(_chat, entry) { effects.push(['receipt', locked, entry.receipt]); },
        isControlInputViewCurrent(_chat, view) { effects.push(['view', locked, view]); return !spec.staleView; },
        discardPreparedInput(_chat, id) { effects.push(['discard', id]); },
        publishIdle() { effects.push(['idle']); },
        publishProjectUnavailable(_chat, error) { effects.push(['unavailable', failure(error)]); },
        publishTurnFailed(_chat, message, options) { effects.push(['failed', message, selected(options)]); },
        publishTurnStarted(_chat, runId) { started = runId; effects.push(['started', locked, runId]); },
        retireAttempt(_chat, attempt) { effects.push(['retire', attempt.identity().turnId]); owner.retireAttempt(CHAT, attempt); },
      },
    });
    const result = await outcome(() => drainer.run(CHAT));
    if (spec.failRemoval) controls.dequeueNextTurn = dequeue;
    if (spec.lateFailure) {
      late.resolve();
      await lateObserved.promise;
    }
    const current = repository.load(CHAT);
    return {
      result, effects,
      entries: current.entries.map((entry) => [entry.content, entry.images]),
      controls: current.controlEntries.map(entry => entry.content),
      pause: current.pause?.kind ?? null,
      finalization: await owner.finalization(CHAT, started),
    };
  });
}
