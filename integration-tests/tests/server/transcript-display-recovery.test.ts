import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { appendDisplayHistory, appendDisplayRun, createDisplayChat } from '../../support/transcript-display-fixture.js';
import { displayBodies, displayRequest } from '../../support/transcript-display.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('display checkpoints survive controller death and resume the source suffix', async () => {
  await withIntegrationFixture('display-process-checkpoint', async fixture => {
    const chatId = await createDisplayChat(fixture);
    await fixture.restartGarcon({ beforeStart: async () => { await appendDisplayRun(fixture.dirs.workspace, chatId, 1500); } });
    const first = await fixture.client.openDisplay({ chatId, reason: 'activate', outstandingClientMessageIds: [] });
    const previous = await fixture.client.waitForDisplayWindow(displayRequest(first));
    await fixture.crashAndRestartGarcon({ beforeStart: () => appendDisplayHistory(fixture.dirs.workspace, chatId, 10) });
    const next = await fixture.client.openDisplay({ chatId, reason: 'reconnect', outstandingClientMessageIds: [] });
    expect(next.serverInstanceId).not.toBe(first.serverInstanceId);
    expect(next.transcriptViewId).toBe(first.transcriptViewId);
    const request = displayRequest(next), current = await fixture.client.waitForDisplayWindow(request);
    expect(current.certificate.watermark).toBe(previous.certificate.watermark + 10);
    expect(current.items.find(item => item.kind === 'tool-group')).toMatchObject({ count: 1500 });
    expect(current.items.filter(item => item.kind === 'row' && item.ordinal > previous.certificate.watermark)).toHaveLength(10);
    expect(await rejectionOf(displayBodies(fixture.client, request, previous)))
      .toMatchObject({ status: 409, body: { errorCode: 'DISPLAY_STALE_CERTIFICATE' } });
  });
}, 90_000);

test.each(['corrupt', 'schema'] as const)('rebuilds a %s derived file without changing source identity or content', async damage => {
  await withIntegrationFixture(`display-rebuild-${damage}`, async fixture => {
    const chatId = await createDisplayChat(fixture);
    await fixture.restartGarcon({ beforeStart: async () => { await appendDisplayRun(fixture.dirs.workspace, chatId, 600); } });
    const open = await fixture.client.openDisplay({ chatId, reason: 'activate', outstandingClientMessageIds: [] });
    const previous = await fixture.client.waitForDisplayWindow(displayRequest(open));
    const source = await fixture.client.getMessages(chatId, { limit: 10 });
    await fixture.restartGarcon({ beforeStart: async () => {
      const directory = join(fixture.dirs.workspace, 'transcript-display', chatId);
      const filename = (await readdir(directory)).find(name => name.endsWith('.sqlite'));
      if (!filename) throw new Error('Missing prepared display file.');
      const path = join(directory, filename);
      if (damage === 'corrupt') {
        await rm(`${path}-wal`, { force: true });
        await rm(`${path}-shm`, { force: true });
        await writeFile(path, 'Synthetic invalid derived database');
      } else {
        const database = new Database(path);
        try { database.run('PRAGMA user_version = 999'); } finally { database.close(); }
      }
    } });
    const restored = await fixture.client.openDisplay({ chatId, reason: 'reconnect', outstandingClientMessageIds: [] });
    const current = await fixture.client.waitForDisplayWindow(displayRequest(restored));
    expect(current.items).toEqual(previous.items);
    expect(current.certificate.watermark).toBe(previous.certificate.watermark);
    expect(await fixture.client.getMessages(chatId, { limit: 10 })).toEqual(source);
  });
}, 90_000);

test('source rollback and regrowth before lazy display admission cannot reuse the old prefix', async () => {
  await withIntegrationFixture('display-process-regrowth', async fixture => {
    const chatId = await createDisplayChat(fixture);
    let promptOrdinal = 0;
    await fixture.restartGarcon({ beforeStart: async () => {
      promptOrdinal = (await appendDisplayRun(fixture.dirs.workspace, chatId, 600)).promptOrdinal;
    } });
    const open = await fixture.client.openDisplay({ chatId, reason: 'activate', outstandingClientMessageIds: [] });
    await fixture.client.waitForDisplayWindow(displayRequest(open));
    await fixture.crashAndRestartGarcon({ beforeStart: async () => {
      const database = new Database(join(fixture.dirs.workspace, 'transcript-ledgers', chatId, 'ledger.sqlite'));
      try { database.run('DELETE FROM transcript_rows WHERE ordinal > ?', [promptOrdinal]); } finally { database.close(); }
      await appendDisplayHistory(fixture.dirs.workspace, chatId, 1300);
    } });
    const restored = await fixture.client.openDisplay({ chatId, reason: 'reconnect', outstandingClientMessageIds: [] });
    expect(restored.transcriptViewId).toBe(open.transcriptViewId);
    expect(restored.sourceHead).toBeGreaterThan(open.sourceHead);
    const request = displayRequest(restored), current = await fixture.client.waitForDisplayWindow(request);
    expect(current.items).toHaveLength(50);
    expect(current.items.every(item => item.kind === 'row')).toBe(true);
    const bodies = await displayBodies(fixture.client, request, current);
    expect(bodies.bodies.every(row => row.message.type === 'assistant-message')).toBe(true);
    expect(bodies.details.every(detail => detail.pairedResult === null)).toBe(true);
  });
}, 90_000);

test('deletion during cold display preparation retires work without recreating its files', async () => {
  await withIntegrationFixture('display-delete-preparing', async fixture => {
    const chatId = await createDisplayChat(fixture);
    await fixture.restartGarcon({ beforeStart: async () => { await appendDisplayRun(fixture.dirs.workspace, chatId, 40_000); } });
    const open = await fixture.client.openDisplay({ chatId, reason: 'activate', outstandingClientMessageIds: [] });
    expect(open.display.phase).toBe('preparing');
    await fixture.client.deleteChat(chatId);
    expect(await rejectionOf(fixture.client.displayWindow(displayRequest(open)))).toMatchObject({ status: 404 });
    await fixture.restartGarcon();
    expect((await readdir(join(fixture.dirs.workspace, 'transcript-display'))).includes(chatId)).toBe(false);
    expect((await readdir(join(fixture.dirs.workspace, 'transcript-ledgers'))).includes(chatId)).toBe(false);
  });
}, 90_000);
