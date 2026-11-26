#!/usr/bin/env bun
// Measures user-level flows end to end on the TypeScript controller and behind
// the Rust front door: a chat turn through the scripted provider, a follow-up
// turn, a transcript fetch, and a real Chromium page load of that chat, cold
// and warm. Both controllers run side by side and are measured in alternating
// order. Requires `bun run build` and `bun run rust:build`; see
// rust/BENCHMARKS.md.

import { parseArgs } from 'node:util';
import { authenticateChromiumContext, withChromiumFixture, type ChromiumFixture } from '../support/chromium-fixture.js';

type Sample = Record<string, number>;

const CONTROLLERS = ['original', 'front-door'] as const;
type Controller = (typeof CONTROLLERS)[number];

async function chatFlow(fixture: ChromiumFixture, iteration: number): Promise<{ chatId: string; sample: Sample }> {
  const { client, directAgents, executionDirs } = fixture.integration;
  const chatId = fixture.integration.newChatId();
  const startedAt = performance.now();
  const started = await client.startDirectChat({
    chatId,
    content: `Benchmark question ${iteration}`,
    projectPath: executionDirs.project,
    agent: directAgents.openAi,
  });
  await client.waitForTurnTerminal(chatId, started.turnId);
  const firstTurn = performance.now() - startedAt;

  const followUpAt = performance.now();
  const followUp = await client.runDirectChat({ chatId, content: `Follow-up ${iteration}`, agent: directAgents.openAi });
  await client.waitForTurnTerminal(chatId, followUp.turnId);
  const followUpTurn = performance.now() - followUpAt;

  const fetchAt = performance.now();
  await client.getMessages(chatId);
  const transcriptFetch = performance.now() - fetchAt;
  return { chatId, sample: { 'new chat turn': firstTurn, 'follow-up turn': followUpTurn, 'transcript fetch': transcriptFetch } };
}

// Loads the chat in a browser until its assistant reply is on screen and reads
// the navigation timing the browser recorded.
async function pageLoad(fixture: ChromiumFixture, chatId: string): Promise<Sample> {
  const context = await fixture.browser.newContext();
  try {
    await authenticateChromiumContext(context, fixture.integration);
    const page = await context.newPage();
    const url = `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`;
    const reply = page.locator('[data-chat-message-type="assistant-message"]').first();
    const load = async (navigate: () => Promise<unknown>): Promise<Sample> => {
      const startedAt = performance.now();
      await navigate();
      await reply.waitFor({ state: 'visible' });
      const visible = performance.now() - startedAt;
      const timing = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        return {
          firstByte: navigation.responseStart - navigation.startTime,
          domContentLoaded: navigation.domContentLoadedEventEnd - navigation.startTime,
          load: navigation.loadEventEnd - navigation.startTime,
          requests: resources.length + 1,
        };
      });
      return { 'reply visible': visible, 'first byte': timing.firstByte, 'DOM content loaded': timing.domContentLoaded, 'load event': timing.load, requests: timing.requests };
    };
    const cold = await load(() => page.goto(url, { waitUntil: 'load' }));
    const warm = await load(() => page.reload({ waitUntil: 'load' }));
    const prefixed = (label: string, sample: Sample) =>
      Object.fromEntries(Object.entries(sample).map(([name, value]) => [`${label}: ${name}`, value]));
    return { ...prefixed('cold load', cold), ...prefixed('warm reload', warm) };
  } finally {
    await context.close();
  }
}

function withController<T>(controller: Controller, run: (fixture: ChromiumFixture) => Promise<T>): Promise<T> {
  // The fixture reads the controller selection when it starts the server.
  process.env.GARCON_TEST_CONTROLLER = controller;
  delete process.env.GARCON_RS_SHADOW_LOG;
  return withChromiumFixture(`e2e-benchmark-${controller}`, run);
}

// The median and 90th percentile of the samples.
function summary(values: number[]): { median: number; p90: number } {
  const sorted = [...values].sort((left, right) => left - right);
  return { median: sorted[Math.floor(sorted.length / 2)]!, p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]! };
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { iterations: { type: 'string', default: '15' }, output: { type: 'string' } },
});
const iterations = Number(values.iterations);
const samples: Record<Controller, Sample[]> = { original: [], 'front-door': [] };

await withController('original', (original) => withController('front-door', async (frontDoor) => {
  const fixtures: Record<Controller, ChromiumFixture> = { original, 'front-door': frontDoor };
  // One unmeasured pass warms both servers, the provider fakes, and the browser.
  for (const controller of CONTROLLERS) {
    const { chatId } = await chatFlow(fixtures[controller], -1);
    await pageLoad(fixtures[controller], chatId);
  }
  for (let iteration = 0; iteration < iterations; iteration++) {
    const order = iteration % 2 === 0 ? CONTROLLERS : [...CONTROLLERS].reverse();
    for (const controller of order) {
      const { chatId, sample } = await chatFlow(fixtures[controller], iteration);
      samples[controller].push({ ...sample, ...await pageLoad(fixtures[controller], chatId) });
    }
    console.error(`iteration ${iteration + 1}/${iterations}`);
  }
}));

const metrics = Object.keys(samples.original[0]!);
const lines = [
  `| Flow | Original median | Front door median | Change | Original p90 | Front door p90 |`,
  `| --- | ---: | ---: | ---: | ---: | ---: |`,
];
for (const metric of metrics) {
  const original = summary(samples.original.map((sample) => sample[metric]!));
  const frontDoor = summary(samples['front-door'].map((sample) => sample[metric]!));
  const isCount = metric.endsWith('requests');
  const show = (value: number) => (isCount ? String(Math.round(value)) : `${value.toFixed(1)} ms`);
  const delta = frontDoor.median - original.median;
  const change = isCount ? '' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} ms`;
  lines.push(`| ${metric} | ${show(original.median)} | ${show(frontDoor.median)} | ${change} | ${show(original.p90)} | ${show(frontDoor.p90)} |`);
}
const report = [
  '# End-to-end benchmarks',
  '',
  'User-level flows on the TypeScript original and behind the Rust front door, generated by `bun integration-tests/bench/e2e-benchmark.ts`. Unlike [BENCHMARKS.md](BENCHMARKS.md), which isolates single requests, these measure what a user waits for.',
  '',
  '## Method',
  '',
  `- Both controllers run at once in isolated integration fixtures with authentication, the production web build, and the scripted OpenAI-compatible provider, which replies deterministically. Each of ${iterations} iterations runs every flow on both, in alternating order, after one unmeasured warm-up pass.`,
  '- A chat turn is timed from the start or run request until the turn terminal arrives on the WebSocket. Page loads use a fresh Chromium context (cold) and then a reload in it (warm), and are timed until the assistant reply is visible; the other page metrics come from the navigation timing the browser records.',
  '',
  '## Results',
  '',
  ...lines,
].join('\n');
if (values.output) await Bun.write(values.output, `${report}\n`);
console.log(lines.join('\n'));
