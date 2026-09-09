import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ChatMessagesMessage, ServerWsMessage } from '../../../common/ws-events.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

const WORKSPACE = 'stop-agent';

async function childOutcome(fixture: IntegrationFixture, parent: string, ref: string, status: string, afterIndex: number) {
  const event = await fixture.client.waitForEvent(
    (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === parent
      && event.messages.some(({ message }) => message.type === 'transcript-notice'
        && message.detail && 'ref' in message.detail && message.detail.ref === ref
        && 'status' in message.detail && message.detail.status === status),
    `child ${ref} ${status}`, { afterIndex },
  );
  const detail = messagesOfType(event.messages, 'transcript-notice').find((message) =>
    message.detail && 'ref' in message.detail && message.detail.ref === ref)?.detail;
  if (!detail || !('chatId' in detail) || typeof detail.chatId !== 'string') throw new Error('Missing child identity');
  return detail;
}

for (const creation of ['markup', 'cli'] as const) for (const remove of [false, true]) {
  test(`${creation} delegated child can be ${remove ? 'removed while active' : 'stopped and resumed'} without a stop reply`, async () => {
    await withIntegrationFixture(`stop-agent-${creation}-${remove}`, async (fixture) => {
      const agent = fixture.directAgents.openAiResponses;
      const model = fixture.fakeProviders.openAiResponses;
      const parent = fixture.newChatId();
      const initial = model.holdNext({ lastUserText: 'Synthetic parent task.' });
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startDirectChat({ chatId: parent, projectPath: fixture.dirs.project,
        content: 'Synthetic parent task.', agent });
      await initial.received;
      initial.releaseText('Synthetic parent ready.');
      await fixture.client.waitForTurnTerminal(parent, started.turnId!, { afterIndex: cursor });

      const heldChild = model.holdNext({ lastUserText: 'Synthetic child task.' });
      let child: string;
      if (creation === 'cli') {
        const processRun = Bun.spawn([process.execPath, 'cli/main.ts', '--config-dir', fixture.dirs.config,
          '--workspace', WORKSPACE, 'start-async', '--cwd', fixture.dirs.project, '--agent', agent.agentId,
          '--provider', agent.provider.providerId, '--endpoint', agent.provider.endpointId,
          '--model', agent.provider.model, '--parent', parent, 'Synthetic child task.'], {
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: { ...process.env, GARCON_CONFIG_DIR: '', GARCON_WORKSPACE: '' }, stdout: 'pipe', stderr: 'pipe',
        });
        const [code, stdout, stderr] = await Promise.all([processRun.exited,
          new Response(processRun.stdout).text(), new Response(processRun.stderr).text()]);
        expect(stderr).toBe('');
        expect(code).toBe(0);
        const id = /^chat id: (\d{16})$/m.exec(stdout)?.[1];
        if (!id) throw new Error('CLI omitted child identity');
        child = id;
      } else {
        const emission = model.holdNext({ lastUserText: 'Delegate synthetic work.' });
        const ack = model.holdNext({ lastUserTextIncludes: 'status="accepted"' });
        await fixture.client.runDirectChat({ chatId: parent, content: 'Delegate synthetic work.', agent });
        await emission.received;
        emission.releaseText(`<garcon-start-agent ref="child" async="true" agent="${agent.agentId}" provider="${agent.provider.providerId}" model="${agent.provider.model}">Synthetic child task.</garcon-start-agent>`);
        child = (await childOutcome(fixture, parent, 'child', 'accepted', cursor)).chatId as string;
        await ack.received;
        const ackCursor = fixture.client.markEvents();
        ack.releaseText('Synthetic delegation acknowledged.');
        await fixture.client.waitForProcessing(parent, false, { afterIndex: ackCursor });
      }
      await heldChild.received;
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === child)?.parentChat)
        .toEqual({ chatId: parent, relation: 'delegation' });

      const stopEmission = model.holdNext({ lastUserText: 'Stop synthetic child.' });
      const beforeStop = model.requests().length;
      const stopCursor = fixture.client.markEvents();
      const stop = await fixture.client.runDirectChat({ chatId: parent, content: 'Stop synthetic child.', agent });
      await stopEmission.received;
      heldChild.expectAbort();
      stopEmission.releaseText(`Synthetic stop issued.\n<garcon-stop-agent chat-id="${child}"${remove ? ' remove="true"' : ''} />`);
      if (remove) {
        await fixture.client.waitForEvent((event): event is ServerWsMessage => event.type === 'chat-session-deleted' && event.chatId === child,
          'delegated child deleted', { afterIndex: stopCursor });
        expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === child)).toBe(false);
        await expect(fixture.client.getMessages(child)).rejects.toThrow();
      } else {
        await fixture.client.waitForSessionStopped(child, { afterIndex: stopCursor });
        expect(userContents((await fixture.client.getMessages(child)).messages)).toEqual(['Synthetic child task.']);
      }
      await fixture.client.waitForTurnTerminal(parent, stop.turnId!, { afterIndex: stopCursor });
      expect(model.requests()).toHaveLength(beforeStop + 1);
      const history = await fixture.client.getMessages(parent);
      expect(JSON.stringify(history)).not.toContain('agent-stop-request');
      expect(JSON.stringify(history)).not.toContain('stop-agent-result');
      expect(messagesOfType(history.messages, 'assistant-message').at(-1)?.content).toBe('Synthetic stop issued.');

      if (!remove) {
        const next = model.holdNext({ lastUserTextIncludes: 'Synthetic resumed task.' });
        const emission = model.holdNext({ lastUserText: 'Resume synthetic child.' });
        const ack = model.holdNext({ lastUserTextIncludes: 'status="accepted"' });
        const resumeCursor = fixture.client.markEvents();
        await fixture.client.runDirectChat({ chatId: parent, content: 'Resume synthetic child.', agent });
        await emission.received;
        emission.releaseText(`<garcon-resume-agent ref="resumed" async="true" chat-id="${child}">Synthetic resumed task.</garcon-resume-agent>`);
        expect(await childOutcome(fixture, parent, 'resumed', 'accepted', resumeCursor)).toMatchObject({ chatId: child });
        await next.received;
        await ack.received;
        ack.releaseText('Synthetic resume acknowledged.');
        next.releaseText('Synthetic resumed final.');
        await fixture.client.waitForProcessing(child, false, { afterIndex: resumeCursor });
        expect(userContents((await fixture.client.getMessages(child)).messages))
          .toEqual(['Synthetic child task.', 'Synthetic resumed task.']);
      }
    }, { namedWorkspace: WORKSPACE });
  }, 60_000);
}

for (const remove of [false, true]) test(`stop with remove=${remove} releases parent locks before a synchronous child result`, async () => {
  await withIntegrationFixture(`stop-child-waiter-${remove}`, async (fixture) => {
    const agent = fixture.directAgents.openAiResponses;
    const model = fixture.fakeProviders.openAiResponses;
    const parent = fixture.newChatId();
    const emission = model.holdNext({ lastUserText: 'Delegate pending work.' });
    const childRun = model.holdNext({ lastUserText: 'Pending child work.' });
    const ack = model.holdNext({ lastUserTextIncludes: 'status="accepted"' });
    const terminal = model.holdNext({ lastUserTextIncludes: 'status="interrupted"' });
    const cursor = fixture.client.markEvents();
    await fixture.client.startDirectChat({ chatId: parent, projectPath: fixture.dirs.project, content: 'Delegate pending work.', agent });
    await emission.received;
    emission.releaseText(`<garcon-start-agent ref="pending" agent="${agent.agentId}" provider="${agent.provider.providerId}" model="${agent.provider.model}">Pending child work.</garcon-start-agent>`);
    const admitted = await childOutcome(fixture, parent, 'pending', 'accepted', cursor);
    const child = admitted.chatId as string;
    await childRun.received;
    await ack.received;
    await fixture.client.enqueueNew(child, 'Synthetic queued work.');
    const pending = await fixture.client.getExecutionControl(child);
    childRun.expectAbort();
    ack.releaseText(`<garcon-stop-agent chat-id="${child}" remove="${remove}" />`);
    const interrupted = await childOutcome(fixture, parent, 'pending', 'interrupted', cursor);
    expect(interrupted).toMatchObject({ reason: remove ? 'chat-deleted' : 'user-stop',
      output: { availability: 'unavailable', reason: 'no-final-response' } });
    await terminal.received;
    const terminalCursor = fixture.client.markEvents();
    terminal.releaseText('Synthetic terminal observed.');
    await fixture.client.waitForProcessing(parent, false, { afterIndex: terminalCursor });
    if (remove) {
      expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === child)).toBe(false);
      return;
    }

    const stopped = await fixture.client.getExecutionControl(child);
    expect(stopped.queue.entries).toEqual(pending.queue.entries);
    expect(stopped.queue.pause).toMatchObject({ kind: 'manual' });
    const resume = model.holdNext({ lastUserText: 'Try a child resume.' });
    const rejected = model.holdNext({ lastUserTextIncludes: 'status="rejected"' });
    const resumeCursor = fixture.client.markEvents();
    await fixture.client.runDirectChat({ chatId: parent, content: 'Try a child resume.', agent });
    await resume.received;
    resume.releaseText(`<garcon-resume-agent ref="busy" chat-id="${child}">Must not overtake the queue.</garcon-resume-agent>`);
    expect(await childOutcome(fixture, parent, 'busy', 'rejected', resumeCursor)).toMatchObject({ reason: 'busy' });
    await rejected.received;
    rejected.releaseText('Synthetic busy rejection observed.');
    expect((await fixture.client.getExecutionControl(child)).queue.pause).toEqual(stopped.queue.pause);
    expect(model.requests().some((request) => request.lastUserText.includes('Must not overtake'))).toBe(false);
    const queued = model.holdNext({ lastUserTextIncludes: 'Synthetic queued work.' });
    const queueCursor = fixture.client.markEvents();
    if (!stopped.queue.pause) throw new Error('Missing stop pause');
    await fixture.client.resumeQueue(child, stopped.queue.pause.id);
    await queued.received;
    queued.releaseText('Synthetic queued work completed.');
    await fixture.client.waitForProcessing(child, false, { afterIndex: queueCursor });
    expect((await fixture.client.getExecutionControl(child)).queue.entries).toEqual([]);
    expect(JSON.stringify(await fixture.client.getMessages(parent))).not.toContain('stop-agent-result');
  }, { namedWorkspace: WORKSPACE });
}, 60_000);
