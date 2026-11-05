import { expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { appendDisplayRun, createDisplayChat } from '../../support/transcript-display-fixture.js';
import { displayBodies, displayRequest } from '../../support/transcript-display.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('[TLV5-DISPLAY.01-SERVER-01] real routes keep collapsed reads bounded and address a deep member directly', async () => {
  await withIntegrationFixture('display-collapsed-routes', async fixture => {
    const sizes = [600, 1500, 40_000];
    const chats: { pairs: number; chatId: string }[] = [];
    for (const pairs of sizes) chats.push({ chatId: await createDisplayChat(fixture), pairs });
    const seeded: Awaited<ReturnType<typeof appendDisplayRun>>[] = [];
    await fixture.restartGarcon({ beforeStart: async () => {
      for (const chat of chats) seeded.push(await appendDisplayRun(fixture.dirs.workspace, chat.chatId, chat.pairs));
    } });
    const bytes = [];
    for (const seed of seeded) {
      const started = performance.now();
      const open = await fixture.client.openDisplay({ chatId: seed.chatId, reason: 'activate', outstandingClientMessageIds: [] });
      const request = displayRequest(open);
      const window = await fixture.client.waitForDisplayWindow(request, 90_000);
      const group = window.items.find(item => item.kind === 'tool-group');
      expect(group?.count).toBe(seed.pairs);
      expect(window.items.some(item => item.kind === 'row' && item.ordinal === seed.promptOrdinal)).toBe(true);
      expect(window.items.length).toBeLessThanOrEqual(5);
      const bodies = await displayBodies(fixture.client, request, window);
      expect(bodies.bodies.every(row => row.message.type !== 'bash-tool-use' && row.message.type !== 'tool-result')).toBe(true);
      bytes.push(Buffer.byteLength(JSON.stringify({ window, bodies })));
      const resolved = await fixture.client.resolveDisplay({ ...request, anchor: { kind: 'around', ordinal: seed.targetOrdinal } });
      expect(resolved.kind).toBe('group-member');
      if (!group) throw new Error('Missing collapsed run.');
      const members = await fixture.client.displayMembers({ certificate: window.certificate, profile: request.profile,
        cuts: [], base: group.base, fragment: group.fragment, anchor: { kind: 'around', ordinal: seed.targetOrdinal }, limit: 50 });
      expect(members.ordinals).toHaveLength(50);
      expect(members.ordinals).toContain(seed.targetOrdinal);
      const selected = await displayBodies(fixture.client, request, window, [seed.targetOrdinal]);
      expect(selected.bodies.map(row => row.ordinal)).toEqual([seed.targetOrdinal, seed.targetOrdinal + 1]);
      expect(selected.details[0]?.pairedResult).toBe(seed.targetOrdinal + 1);
      const timings = [];
      for (let index = 0; index < 20; index++) {
        const start = performance.now();
        expect((await fixture.client.displayWindow(request)).kind).toBe('available');
        timings.push(performance.now() - start);
      }
      timings.sort((a, b) => a - b);
      console.log(JSON.stringify({ displayPairs: seed.pairs, preparationMs: performance.now() - started,
        warmP95Ms: timings[18], responseBytes: bytes.at(-1) }));
      expect(timings[18]).toBeLessThan(50);
      expect(await rejectionOf(fixture.client.displayWindow({ ...request, transcriptViewId: 'synthetic-stale-view' })))
        .toMatchObject({ status: 409, body: { errorCode: 'STALE_TRANSCRIPT_VIEW' } });
    }
    expect(Math.max(...bytes) - Math.min(...bytes)).toBeLessThan(1000);
    expect(fixture.client.rawEvents().some(event => typeof event === 'object' && event !== null
      && ['chat-messages', 'chat-subscribed'].includes(String((event as Record<string, unknown>).type)))).toBe(false);
  });
}, 180_000);
