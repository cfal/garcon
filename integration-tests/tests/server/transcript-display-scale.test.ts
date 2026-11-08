import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import type { AvailableDisplayWindow } from '../../../common/transcript-display-contract.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { appendDisplayRun, createDisplayChat, DISPLAY_PROMPT } from '../../support/transcript-display-fixture.js';
import { displayBodies, displayRequest, measuredDisplaySnapshot } from '../../support/transcript-display.js';

test.skipIf(process.env.GARCON_TEST_DISPLAY_SCALE !== '1')('200,000 collapsed pairs preserve bounded route and member work', async () => {
  await withIntegrationFixture('display-scale', async fixture => {
    const chatId = await createDisplayChat(fixture);
    let targetOrdinal = 0, promptOrdinal = 0;
    await fixture.restartGarcon({ beforeStart: async () => {
      ({ targetOrdinal, promptOrdinal } = await appendDisplayRun(fixture.dirs.workspace, chatId, 200_000));
    } });
    const started = performance.now();
    const rss = async () => {
      if (process.platform !== 'linux' || !fixture.garcon.pid) return null;
      const status = await readFile(`/proc/${fixture.garcon.pid}/status`, 'utf8');
      const value = status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1];
      if (!value) throw new Error('The controller RSS sample is missing.');
      return Number(value) * 1024;
    };
    const initialRssBytes = await rss();
    let peakRssBytes = initialRssBytes;
    const open = await fixture.client.openDisplay({ chatId, reason: 'activate', outstandingClientMessageIds: [] });
    const request = displayRequest(open);
    let window: AvailableDisplayWindow | null = null;
    while (performance.now() - started < 180_000) {
      const response = await fixture.client.displayWindow(request);
      const resident = await rss();
      if (resident !== null) peakRssBytes = Math.max(peakRssBytes ?? 0, resident);
      if (response.kind === 'available') { window = response; break; }
      if (response.kind === 'failed') throw new Error(response.errorCode ?? 'Display preparation failed.');
      await Bun.sleep(100);
    }
    if (!window) throw new Error('The scale fixture did not finish preparing.');
    const preparationMs = performance.now() - started;
    const group = window.items.find(item => item.kind === 'tool-group');
    if (!group) throw new Error('Missing collapsed group.');
    expect(group.count).toBe(200_000);
    expect(window.items.length).toBeLessThan(6);
    const measured = await measuredDisplaySnapshot(fixture.client, request, window), { bodies } = measured;
    expect(measured.window).toEqual(window);
    expect(bodies.bodies.find(row => row.ordinal === promptOrdinal)?.message).toMatchObject({ type: 'user-message', content: DISPLAY_PROMPT });
    expect(bodies.deferredOrdinals).not.toContain(promptOrdinal);
    expect(bodies.nonRenderedOrdinals).not.toContain(promptOrdinal);
    expect(bodies.bodies.every(row => row.message.type !== 'bash-tool-use' && row.message.type !== 'tool-result')).toBe(true);
    const samples: number[] = [];
    for (let index = 0; index < 20; index++) {
      const before = performance.now();
      const members = await fixture.client.displayMembers({ certificate: window.certificate, profile: request.profile,
        cuts: [], base: group.base, fragment: group.fragment, anchor: { kind: 'around', ordinal: targetOrdinal }, limit: 50 });
      samples.push(performance.now() - before);
      expect(members.ordinals).toHaveLength(50);
      expect(members.ordinals).toContain(targetOrdinal);
    }
    samples.sort((left, right) => left - right);
    const selected = await displayBodies(fixture.client, request, window, [targetOrdinal]);
    expect(selected.bodies.map(row => row.ordinal)).toEqual([targetOrdinal, targetOrdinal + 1]);
    const responseBytes = measured.bytes;
    expect(responseBytes).toBeLessThan(5000);
    expect(samples[18]).toBeLessThan(50);
    console.log(JSON.stringify({ displayPairs: 200_000, preparationMs, memberP95Ms: samples[18], responseBytes,
      initialRssBytes, peakRssBytes }));
  });
}, 240_000);
