import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { appendDisplayRun, createDisplayChat, DISPLAY_PROMPT, DISPLAY_TIMESTAMP } from '../../support/transcript-display-fixture.js';
import { displayBodies, displayRequest, measuredDisplaySnapshot } from '../../support/transcript-display.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import type { DisplayWindowRequest } from '../../../common/transcript-display-contract.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { chatIdRequestNoticeDraft } from '../../../server/controller/ledger/garcon-command-request.js';

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
      const measured = await measuredDisplaySnapshot(fixture.client, request, window), { bodies } = measured;
      expect(measured.window).toEqual(window);
      expect(bodies.bodies.find(row => row.ordinal === seed.promptOrdinal)?.message).toMatchObject({ type: 'user-message', content: DISPLAY_PROMPT });
      expect(bodies.deferredOrdinals).not.toContain(seed.promptOrdinal);
      expect(bodies.nonRenderedOrdinals).not.toContain(seed.promptOrdinal);
      expect(bodies.bodies.every(row => row.message.type !== 'bash-tool-use' && row.message.type !== 'tool-result')).toBe(true);
      bytes.push(measured.bytes);
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

test('non-combined HTTP windows traverse every eligible tool in both directions with lazy result hydration', async () => {
  await withIntegrationFixture('display-non-combined-pages', async fixture => {
    const chatId = await createDisplayChat(fixture);
    let seed!: Awaited<ReturnType<typeof appendDisplayRun>>;
    await fixture.restartGarcon({ beforeStart: async () => {
      seed = await appendDisplayRun(fixture.dirs.workspace, chatId, 137);
    } });
    const open = await fixture.client.openDisplay({ chatId, reason: 'activate', outstandingClientMessageIds: [] });
    const combined = displayRequest(open);
    const request = { ...combined, profile: { ...combined.profile, combine: false }, limit: 17 };
    const latest = await fixture.client.waitForDisplayWindow(request);
    const expected = Array.from({ length: seed.pairs }, (_, index) => seed.promptOrdinal + 1 + index * 2);

    for (const direction of ['earlier', 'later'] as const) {
      let anchor: DisplayWindowRequest['anchor'] = direction === 'earlier' ? { kind: 'newest' }
        : { kind: 'after', cursor: { certificate: latest.certificate, boundaryOrdinal: seed.promptOrdinal } };
      const collected: number[] = [];
      let exhausted = false;
      for (let pages = 0; pages < seed.pairs; pages++) {
        const window = await fixture.client.waitForDisplayWindow({ ...request, atWatermark: latest.certificate.watermark, anchor });
        expect(window.certificate).toEqual(latest.certificate);
        expect(window.items.length).toBeGreaterThan(0);
        expect(window.items.length).toBeLessThanOrEqual(request.limit);
        expect(window.items.every(item => item.kind === 'row')).toBe(true);
        const ordinals = window.items.flatMap(item => item.kind === 'row' && item.ordinal > seed.promptOrdinal ? [item.ordinal] : []);
        if (direction === 'earlier') collected.unshift(...ordinals);
        else collected.push(...ordinals);
        const edge = window[direction];
        if (edge.kind === 'exhausted-through-watermark') { exhausted = true; break; }
        anchor = { kind: direction === 'earlier' ? 'before' : 'after', cursor: edge.cursor };
      }
      expect(exhausted).toBe(true);
      expect(collected).toEqual(expected);
    }

    const selected = [expected[0], expected.at(-1)!];
    const bodies = await displayBodies(fixture.client, request, latest, selected);
    expect(bodies.bodies.map(row => row.ordinal)).toEqual(selected.flatMap(ordinal => [ordinal, ordinal + 1]));
    expect(bodies.details.map(detail => ({ ordinal: detail.ordinal, pairedResult: detail.pairedResult })))
      .toEqual(selected.map(ordinal => ({ ordinal, pairedResult: ordinal + 1 })));
    expect(bodies.deferredOrdinals).toEqual([]);
    const resident = await displayBodies(fixture.client, request, latest, selected, bodies.bodies.map(row => row.ordinal));
    expect(resident.bodies).toEqual([]);
    expect(resident.details).toEqual(bodies.details);

    const collapsed = await fixture.client.waitForDisplayWindow(combined);
    expect(collapsed.items.find(item => item.kind === 'tool-group')?.count).toBe(seed.pairs);
    expect((await displayBodies(fixture.client, combined, collapsed)).bodies.every(row =>
      row.message.type !== 'bash-tool-use' && row.message.type !== 'tool-result')).toBe(true);
  });
}, 90_000);

test('display HTTP access requires authentication and cannot hydrate ledger-private notices', async () => {
  await withIntegrationFixture('display-http-privacy', async fixture => {
    const chatId = await createDisplayChat(fixture);
    let privateOrdinal = 0;
    await fixture.restartGarcon({ beforeStart: async () => {
      const store = new TranscriptLedgerStore(join(fixture.dirs.workspace, 'transcript-ledgers'));
      try {
        const view = store.currentView(chatId);
        if (!view) throw new Error('Missing synthetic transcript view');
        privateOrdinal = store.append(chatId, view.viewId, [chatIdRequestNoticeDraft(DISPLAY_TIMESTAMP)])[0].ordinal;
      } finally { store.close(); }
    } });
    const opening = { chatId, reason: 'activate' as const, outstandingClientMessageIds: [] };
    const open = await fixture.client.openDisplay(opening);
    const request = displayRequest(open), window = await fixture.client.waitForDisplayWindow(request);
    const bodyRequest = { certificate: window.certificate, profile: request.profile, cuts: [],
      seedOrdinals: [privateOrdinal], residentOrdinals: [], limitBodies: 10, estimatedByteBudget: 10000 };
    for (const [operation, body] of [['open', opening], ['window', request], ['bodies', bodyRequest]] as const) {
      const response = await fetch(`${fixture.garcon.baseUrl}/api/v1/chats/transcript-display/${operation}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    expect(window.items.every(item => item.kind !== 'row' || item.ordinal !== privateOrdinal)).toBe(true);
    expect(await fixture.client.displayBodies(bodyRequest)).toMatchObject({
      bodies: [], details: [], deferredOrdinals: [], nonRenderedOrdinals: [privateOrdinal], oversizedOrdinal: null,
    });
    expect(await fixture.client.resolveDisplay({ ...request, anchor: { kind: 'around', ordinal: privateOrdinal } }))
      .toEqual({ kind: 'non-rendered', ordinal: privateOrdinal, landedOrdinal: null });
    expect(await rejectionOf(fixture.client.displayBodies({ ...bodyRequest,
      certificate: { ...window.certificate, serverInstanceId: 'foreign-server' } })))
      .toMatchObject({ status: 409, body: { errorCode: 'DISPLAY_STALE_CERTIFICATE' } });
  });
}, 90_000);
