import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { mergeRuns, type Golden } from '../golden.js';
import { compareScenario } from '../report.js';
import { runScenario, type CaseRun } from '../runner.js';
import type { Scenario } from '../scenario.js';
import type { Json } from '../wildcard.js';

const repoRoot = resolve(import.meta.dir, '../../../..');
const probe = { label: 'probe', command: [process.execPath, resolve(import.meta.dir, 'fixtures/probe-server.ts')] };

// Steps whose responses hold a value a later step names, days relative to the
// clock, a body too large to record, and a value that differs from one start
// to the next.
const scenario: Scenario = {
  name: 'probe',
  description: 'Exercises the placeholders, the days, the large body, and the shaped wildcard.',
  steps: [
    { name: 'create', http: { method: 'POST', path: '/api/v1/things', json: { name: 'one' } } },
    {
      name: 'rename',
      http: { method: 'PATCH', path: '/api/v1/things/{{create.body.id}}', headers: { 'X-Name': '{{create.body.id}}' } },
    },
    { name: 'list', http: { method: 'GET', path: '/api/v1/things' } },
    { name: 'days', http: { method: 'GET', path: '/api/v1/days?since={{todayMinus6}}&until={{today}}' } },
    { name: 'large', http: { method: 'GET', path: '/api/v1/large' } },
  ],
};

async function recording(): Promise<Golden> {
  return mergeRuns(scenario, await runScenario(repoRoot, probe, scenario), await runScenario(repoRoot, probe, scenario));
}

// A case's recorded expectation, which has the shape of a capture.
function recorded(golden: Golden, name: string): { request: { path: string }; body: { value?: Json; kind: string } } {
  return golden.cases.find((entry) => entry.name === name)!.expected as unknown as ReturnType<typeof recorded>;
}

describe('a scenario run against the stand-in controller', () => {
  test('a later step names a value of an earlier response, and later responses repeat it', async () => {
    const golden = await recording();
    const create = golden.cases.find((entry) => entry.name === 'create')!;
    // The response that gave the value keeps the generic placeholder.
    expect(create.expected).toMatchObject({ body: { value: { id: '{{uuid}}', name: 'one' } } });
    expect(create.noise).toEqual([]);
    // The recorded request is the template, and the response shows the value under the placeholder.
    expect(recorded(golden, 'rename').request.path).toBe('/api/v1/things/{{create.body.id}}');
    expect(recorded(golden, 'rename').body.value).toEqual({ id: '{{create.body.id}}', name: '{{create.body.id}}' });
    expect(recorded(golden, 'list').body.value).toEqual({ items: [{ id: '{{create.body.id}}' }], proof: '[..hex:64]' });
    // The proof differs per start, in one alphabet and of one length.
    expect(golden.cases.find((entry) => entry.name === 'list')!.noise).toEqual(['$.body.value.proof']);
  });

  test('a day relative to the clock is sent as a date and comes back under its placeholder', async () => {
    const golden = await recording();
    expect(recorded(golden, 'days').request.path).toBe('/api/v1/days?since={{todayMinus6}}&until={{today}}');
    expect(recorded(golden, 'days').body.value).toEqual({ since: '{{todayMinus6}}', today: '{{today}}' });
    expect(golden.cases.find((entry) => entry.name === 'days')!.noise).toEqual([]);
  });

  test('a body too large to record is compared by the digest of its normalized text', async () => {
    const golden = await recording();
    const large = golden.cases.find((entry) => entry.name === 'large')!;
    // Its port and timestamp differ per start; neither leaves a wildcard.
    expect(large.noise).toEqual([]);
    const normalized = JSON.stringify({ baseUrl: '{{origin}}', createdAt: '{{timestamp}}', text: 'x'.repeat(70_000) });
    expect((large.expected as { body: Json }).body).toEqual({
      kind: 'text-digest',
      length: Buffer.byteLength(normalized),
      sha256: createHash('sha256').update(normalized).digest('hex'),
    });
  });

  test('the recording of two runs is matched by a third', async () => {
    const golden = await recording();
    const third: CaseRun[] = await runScenario(repoRoot, probe, scenario);
    const result = compareScenario(golden, third, 'probe');
    expect(result.cases.map((entry) => [entry.name, entry.difference])).toEqual([
      ['create', null], ['rename', null], ['list', null], ['days', null], ['large', null],
    ]);
  });

  test('fails a step whose placeholder names a step that did not run before it', async () => {
    const broken: Scenario = {
      ...scenario,
      steps: [{ name: 'early', http: { method: 'GET', path: '/api/v1/things/{{missing.body.id}}' } }],
    };
    await expect(runScenario(repoRoot, probe, broken)).rejects.toThrow(
      /early: \{\{missing\.body\.id\}\} has no value: no step named "missing" ran before it\./,
    );
  });
});
