import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { AssistantMessage } from '../../../common/chat-types.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { TranscriptLedgerService } from '../../../server/ledger/service.js';
import { ChatRegistry } from '../../../server/chats/store.js';
import { AgentScheduleController } from '../../../server/chats/agent-schedule-controller.js';
import { ChatExecutionCoordinator } from '../../../server/chat-execution/chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../../../server/chat-execution/chat-execution-control-repository.js';
import { CommandSupport } from '../../../server/commands/command-support.js';
import { CommandLedger } from '../../../server/commands/command-ledger.js';
import { QueueCommands } from '../../../server/commands/queue-commands.js';
import { KeyedPromiseLock } from '../../../server/lib/keyed-lock.js';
import { ScheduledPromptScheduler, cronExpressionForUtcInstant } from '../../../server/scheduled-prompts/scheduler.js';
import { ScheduledPromptStore } from '../../../server/scheduled-prompts/store.js';
import { ScheduledPromptRunLog } from '../../../server/scheduled-prompts/run-log.js';
import { ScheduledPromptDispatcher } from '../../../server/scheduled-prompts/dispatcher.js';

const CHAT = '1111111111111111';
const NOW = '2030-01-01T12:00:20.000Z';
const DUE = '2030-01-01T12:02:00.000Z';
const NEXT = '2030-01-01T12:07:00.000Z';

class FakeCron {
  jobs = [];
  schedule(expression, handler) {
    const job = { expression, stopped: false, stop() { this.stopped = true; },
      fire() { return handler.call(this); } };
    this.jobs.push(job);
    return job;
  }
}

async function withPipeline(run) {
  const root = await mkdtemp(join(tmpdir(), 'garcon-schedule-pipeline-'));
  const registry = new ChatRegistry(root);
  const cron = new FakeCron();
  const schedules = new ScheduledPromptStore(root);
  const lock = new KeyedPromiseLock();
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(root, 'transcripts')), {
    agentSchedules: { request: (...args) => controller.request(...args) },
  });
  await registry.init();
  registry.addChat({ id: CHAT, agentId: 'test', agentOwnershipEpoch: 'synthetic-epoch',
    nativeSession: null, nativeSeedReceipt: null, agentSessionId: '', projectPath: root,
    model: 'initial-model', permissionMode: 'default', thinkingMode: 'none', tags: [],
    agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } },
    preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChat: null,
  });
  const view = ledger.initializeChat(CHAT);
  const publisher = ledger.openProducer(CHAT, 'test');
  const dispatched = [];
  /** @type {import('../../../server/chat-execution/accepted-input-transcript.js').AcceptedInputTranscriptPort} */
  const admission = {
    hasMatchingInput: () => false,
    admitInput: async (...args) => admission.admitQueuedInput(...args),
    admitQueuedInput(chatId, message, options) {
      expect(ledger.currentRows(chatId).filter((row) => row.kind === 'user-input')).toEqual([]);
      return ledger.appendInputAndCompose({ chatId, viewId: options.transcriptViewId, message,
        attachments: [], clientMessageId: options.clientMessageId, steer: false });
    },
    discardPreparedInput: (chatId, messageId) => ledger.discardPreparedInput(chatId, messageId),
  };
  /** @type {import('../../../server/chat-execution/types.js').AgentTurnRunnerPort} */
  const runner = {
    async runAgentTurn(chatId, content, options) {
      expect(ledger.currentRows(chatId).filter((row) => row.kind === 'user-input')).toHaveLength(1);
      dispatched.push({ content, options });
      await execution.onAgentTurnTerminal(chatId, { turnId: options.turnId });
    },
    captureSteerTarget: () => null, isChatRunning: () => false,
    steerInput: async () => { throw new Error('Scheduled actions must not steer'); },
    submitGoalControl: async () => { throw new Error('Unexpected goal control'); },
    abortSession: async () => false,
  };
  const execution = new ChatExecutionCoordinator(root, runner, admission,
    () => ({ model: registry.getChat(CHAT).model, permissionMode: registry.getChat(CHAT).permissionMode, thinkingMode: 'none' }),
    (id) => registry.hasChat(id), new InMemoryChatExecutionControlRepository('synthetic-server'), {
      projectAdmission: { assertAvailable: async () => {} },
      appendControlReceipt: () => {},
      isControlInputViewCurrent: (chatId, viewId) => ledger.existingCurrentView(chatId)?.viewId === viewId,
    });
  const commands = new QueueCommands(new CommandSupport({ chats: registry, queue: execution,
    ledger: new CommandLedger(root), chatMutationLock: lock,
    agents: { currentTranscriptViewId: async (chatId) => ledger.currentView(chatId).viewId },
  }));
  const scheduler = new ScheduledPromptScheduler({ store: schedules, cron, chats: registry,
    agents: { hasAgent: () => true, assertExecutionModeSelectionSupported: () => {} },
    runLog: new ScheduledPromptRunLog(),
    dispatcher: new ScheduledPromptDispatcher({
      commands: { submitScheduledExistingChat: (input) => commands.submitScheduledExistingChat(input),
        submitScheduledStart: async () => { throw new Error('Unexpected new chat'); } },
      chatIds: { allocate: () => { throw new Error('Unexpected allocation'); } },
    }),
  });
  let replyResolve;
  const replied = new Promise((resolve) => { replyResolve = resolve; });
  const controller = new AgentScheduleController({ registry, notices: ledger, chatMutationLock: lock,
    isEnabled: () => true,
    scheduler: { scheduleForChat: (request) => scheduler.scheduleForChat(request, new Date(NOW)) },
    execution: { deliverServerControlInput: async (_chatId, input) => { replyResolve(input); return 'queued'; } },
  });
  try {
    await scheduler.start(new Date(NOW));
    await run({ registry, ledger, view, publisher, cron, schedules, execution, controller, lock, replied, dispatched });
  } finally {
    controller.shutdown(); scheduler.stop(); execution.beginShutdown();
    await execution.waitForDispatches(); await registry.flush(); ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('composed assistant schedule pipeline', () => {
  test('malformed outer openers cannot publish nested schedule requests', async () => {
    await withPipeline(async ({ ledger, publisher, schedules, lock }) => {
      const content = '<garcon-start-agent\n<garcon-schedule in="1m" />\n<garcon-schedule in="5m" />';
      publisher.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(NOW, content) }] });
      await lock.runExclusive(`chat:${CHAT}`, async () => {});
      expect(schedules.list()).toEqual([]);
      const rows = ledger.currentRows(CHAT);
      expect(rows.filter((row) => row.kind === 'provider-row').map((row) => row.message.content)).toEqual([content]);
      expect(rows.some((row) => row.detail?.type === 'agent-schedule-request')).toBe(false);
      expect(rows.some((row) => row.detail?.type === 'agent-schedule-outcome')).toBe(false);
    });
  });

  for (const family of ['start-agent', 'schedule', 'send-message']) {
    for (const prefix of ['', 'Answer\n']) {
      test(`nested closers cannot publish schedules inside an unclosed ${prefix ? 'trailing' : 'leading'} ${family}`, async () => {
        await withPipeline(async ({ ledger, publisher, schedules, lock, cron }) => {
          const contents = [
            `${prefix}<garcon-${family}>\n<garcon-${family}>nested</garcon-${family}>\n<garcon-schedule in="1m" />`,
            `${prefix}<garcon-${family} broken="</garcon-${family}>\n<garcon-schedule in="5m" />`,
            `${prefix}<garcon-${family}>\n<example broken="</garcon-${family}>\n<garcon-schedule in="10m" />`,
            ...[['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?example', '?>']].flatMap(([open, close]) => [
              `${prefix}<garcon-${family}>\n${open}</garcon-${family}>${close}\n<garcon-schedule in="1m" />`,
              `${prefix}<garcon-${family}>\n${open}</garcon-${family}>\n<garcon-schedule in="5m" />`,
            ]),
            `${prefix}<garcon-${family}>\n<!DOCTYPE example [<!ENTITY closer "</garcon-${family}>">]>\n</garcon-${family}>\n<garcon-schedule in="10m" />`,
          ];
          for (const content of contents) {
            publisher.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(NOW, content) }] });
          }
          await lock.runExclusive(`chat:${CHAT}`, async () => {});
          expect(schedules.list()).toEqual([]);
          expect(cron.jobs).toHaveLength(1);
          const rows = ledger.currentRows(CHAT);
          expect(rows.filter((row) => row.kind === 'provider-row').map((row) => row.message.content)).toEqual(contents);
          expect(rows.some((row) => row.detail?.type === 'agent-schedule-request')).toBe(false);
          expect(rows.some((row) => row.detail?.type === 'agent-schedule-outcome')).toBe(false);
        });
      });
    }
  }

  test('late provider commands cannot create schedules after controller shutdown', async () => {
    await withPipeline(async ({ ledger, publisher, schedules, controller, lock, cron }) => {
      controller.shutdown();
      publisher.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(NOW, '<garcon-schedule in="1m" />') }] });
      await lock.runExclusive(`chat:${CHAT}`, async () => {});
      expect(schedules.list()).toEqual([]);
      expect(ledger.currentRows(CHAT).map((row) => row.detail.type)).toEqual(['agent-schedule-request']);
      expect(cron.jobs).toHaveLength(1);
    });
  });

  for (const busy of ['queue', 'skip']) {
    test(`claims a minute recurrence before ordinary ${busy} admission without changing chat configuration`, async () => {
      await withPipeline(async ({ registry, ledger, view, publisher, cron, schedules, execution, replied, dispatched }) => {
        publisher.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(
          '2029-01-01T00:00:00.000Z',
          `<garcon-schedule in="1m" every="5m" busy="${busy}">Inspect {{chat_id}} &amp; report.</garcon-schedule>`,
        ) }] });
        const reply = await replied;
        expect(reply.transcriptViewId).toBe(view.viewId);
        expect(reply.receipt).toBeNull();
        expect(ledger.currentRows(CHAT).map((row) => row.detail.type)).toEqual(['agent-schedule-request', 'agent-schedule-outcome']);
        const saved = schedules.list()[0];
        expect(saved.schedule.nextRunAt).toBe(DUE);
        const reservation = await execution.reserveTranscriptSnapshot(CHAT);
        registry.updateChat(CHAT, { model: 'current-model', permissionMode: 'bypassPermissions' });
        const configured = registry.getChat(CHAT);
        const now = Date.now;
        Date.now = () => Date.parse(DUE);
        try {
          await cron.jobs.find((job) => job.expression === cronExpressionForUtcInstant(DUE)).fire();
        } finally { Date.now = now; }
        expect(schedules.get(saved.id).schedule.nextRunAt).toBe(NEXT);
        expect(cron.jobs.some((job) => !job.stopped && job.expression === cronExpressionForUtcInstant(NEXT))).toBe(true);
        expect(ledger.currentRows(CHAT).filter((row) => row.kind === 'user-input')).toEqual([]);
        expect(dispatched).toEqual([]);
        const pending = await execution.readChatExecutionControl(CHAT);
        expect(pending.entries).toHaveLength(busy === 'queue' ? 1 : 0);
        if (busy === 'queue') {
          const drained = once(execution, 'chat-idle');
          await execution.releaseTranscriptSnapshot(reservation);
          await drained;
          expect(dispatched).toMatchObject([{
            content: `<garcon-schedule-action>\nInspect ${CHAT} &amp; report.\n</garcon-schedule-action>`,
            options: { model: 'current-model', permissionMode: 'bypassPermissions' },
          }]);
        } else await execution.releaseTranscriptSnapshot(reservation);
        expect(registry.getChat(CHAT)).toEqual(configured);
      });
    });
  }
});
