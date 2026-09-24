import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { parseExecutionNodes } from '../../../common/execution-nodes.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const backend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  test(`oversized provider output fails its chat without disconnecting another (${backend})`, async () => {
    await withIntegrationFixture(`oversized-output-${backend}`, async (fixture) => {
      const { client, directAgents, fakeProviders } = fixture;
      const oversizedChat = fixture.newChatId();
      const healthyChat = fixture.newChatId();
      const oversizedOutput = fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic oversized response' });
      const healthyOutput = fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic independent response' });
      healthyOutput.allowAbort();
      const oversized = await client.startDirectChat({
        chatId: oversizedChat, content: 'Synthetic oversized response',
        projectPath: fixture.dirs.project, agent: directAgents.openAi,
      });
      await oversizedOutput.received;
      const healthy = await client.startDirectChat({
        chatId: healthyChat, content: 'Synthetic independent response',
        projectPath: fixture.dirs.project, agent: directAgents.openAi,
      });
      await healthyOutput.received;
      oversizedOutput.releaseText('x'.repeat(17 * 1024 * 1024));
      expect(await client.waitForTurnTerminal(oversizedChat, oversized.turnId)).toMatchObject({ type: 'agent-run-failed' });
      await client.waitForProcessing(oversizedChat, false);
      expect(assistantContents((await client.getMessages(oversizedChat)).messages)).toEqual([]);
      const snapshot = await client.get<{ nodes: unknown }>('/api/v1/execution-nodes');
      expect(parseExecutionNodes(snapshot.nodes)?.find(node => node.id === client.nodeId)?.availability).toBe('ready');
      healthyOutput.releaseText('Synthetic unaffected response');
      expect(await client.waitForTurnTerminal(healthyChat, healthy.turnId)).toMatchObject({ type: 'agent-run-finished' });
      expect(assistantContents((await client.getMessages(healthyChat)).messages)).toEqual(['Synthetic unaffected response']);
    }, { executionBackend: backend, redactSensitiveDiagnostics: true });
  }, 30_000);

  test(`a producer ledger failure leaves other chats on the same node running (${backend})`, async () => {
    await withIntegrationFixture(`producer-fence-${backend}`, async (fixture) => {
      const { client, directAgents, fakeProviders } = fixture;
      const fencedChat = fixture.newChatId();
      const healthyChat = fixture.newChatId();
      const rejectedOutput = fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic fenced input' });
      const healthyOutput = fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic healthy input' });
      healthyOutput.allowAbort();
      await client.startDirectChat({
        chatId: fencedChat, content: 'Synthetic fenced input',
        projectPath: fixture.dirs.project, agent: directAgents.openAi,
      });
      await rejectedOutput.received;
      const healthy = await client.startDirectChat({
        chatId: healthyChat, content: 'Synthetic healthy input',
        projectPath: fixture.dirs.project, agent: directAgents.openAi,
      });
      await healthyOutput.received;
      const db = new Database(join(fixture.dirs.workspace, 'transcript-ledgers', fencedChat, 'ledger.sqlite'));
      try {
        db.exec(`
          CREATE TRIGGER inject_producer_write_failure
          BEFORE INSERT ON transcript_rows
          BEGIN
            SELECT RAISE(FAIL, 'synthetic producer write failure');
          END
        `);
      } finally { db.close(); }
      rejectedOutput.releaseText('Synthetic rejected output');
      const deadline = Date.now() + 5000;
      while (!fixture.garcon.logs.some(line => line.includes(`Transcript ledger is fenced for chat ${fencedChat}`))) {
        if (Date.now() >= deadline) throw new Error(`Producer rejection was not observed.\n${fixture.garcon.describeLogs()}`);
        await Bun.sleep(10);
      }
      const snapshot = await client.get<{ nodes: unknown }>('/api/v1/execution-nodes');
      expect(parseExecutionNodes(snapshot.nodes)?.find(node => node.id === client.nodeId)?.availability).toBe('ready');
      healthyOutput.releaseText('Synthetic healthy output');
      expect(await client.waitForTurnTerminal(healthyChat, healthy.turnId)).toMatchObject({ type: 'agent-run-finished' });
      expect(assistantContents((await client.getMessages(healthyChat)).messages)).toEqual(['Synthetic healthy output']);
      expect(assistantContents((await client.getMessages(fencedChat)).messages)).toEqual([]);
    }, { executionBackend: backend });
  }, 30_000);

  test(`oversized chat input does not interrupt another chat on the node (${backend})`, async () => {
    await withIntegrationFixture(`oversized-input-${backend}`, async (fixture) => {
      const { client, directAgents, fakeProviders } = fixture;
      const healthyChat = fixture.newChatId();
      const held = fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic concurrent input' });
      held.allowAbort();
      const healthy = await client.startDirectChat({
        chatId: healthyChat, content: 'Synthetic concurrent input',
        projectPath: fixture.dirs.project, agent: directAgents.openAi,
      });
      await held.received;
      const data = `data:image/png;base64,${Buffer.alloc(7 * 1024 * 1024).toString('base64')}`;
      const oversizedChat = fixture.newChatId();
      await expect(client.startChat({
        ...client.directStartRequest({
          chatId: oversizedChat, content: 'Synthetic oversized input',
          projectPath: fixture.dirs.project, agent: directAgents.anthropic,
        }),
        images: [{ name: 'first.png', data }, { name: 'second.png', data }],
      })).rejects.toMatchObject({
        status: 503,
        body: { errorCode: 'UNAVAILABLE', error: 'Execution-node request exceeds the message size limit' },
      });
      expect(fakeProviders.anthropic.requests()).toHaveLength(0);
      const snapshot = await client.get<{ nodes: unknown }>('/api/v1/execution-nodes');
      expect(parseExecutionNodes(snapshot.nodes)?.find(node => node.id === client.nodeId)?.availability).toBe('ready');
      held.releaseText('Synthetic uninterrupted output');
      expect(await client.waitForTurnTerminal(healthyChat, healthy.turnId)).toMatchObject({ type: 'agent-run-finished' });
      expect(assistantContents((await client.getMessages(healthyChat)).messages)).toEqual(['Synthetic uninterrupted output']);
    }, { executionBackend: backend, redactSensitiveDiagnostics: true });
  }, 30_000);
}
