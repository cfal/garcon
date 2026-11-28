import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { mergeRuns, type Golden } from '../golden.js';
import { compareScenario, renderReport, replayPassed, replaySummary } from '../report.js';
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
function recorded(golden: Golden, name: string): { status: number; request: { path: string }; body: { value?: Json; kind: string } } {
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

  test('a scenario option starts the server with authentication disabled', async () => {
    const disabled: Scenario = {
      name: 'probe-auth-disabled',
      description: 'Exercises the auth option of a scenario.',
      server: { account: 'none', auth: 'disabled' },
      steps: [
        { name: 'status', http: { method: 'GET', path: '/api/v1/auth/status' } },
        { name: 'login', http: { method: 'POST', path: '/api/v1/auth/login', json: { username: '{{username}}', password: '{{password}}' } } },
      ],
    };
    const golden = mergeRuns(disabled, await runScenario(repoRoot, probe, disabled), await runScenario(repoRoot, probe, disabled));
    // Every request counts as authenticated, and the sign-in route refuses.
    expect(recorded(golden, 'status').body.value).toEqual({ needsSetup: false, isAuthenticated: true, authDisabled: true });
    expect(recorded(golden, 'login').status).toBe(403);
    expect(recorded(golden, 'login').body.value).toMatchObject({ errorCode: 'AUTH_CHANGE_FORBIDDEN' });
  });

  test('reports a missing supplier as a mismatch and refuses to record it', async () => {
    const broken: Scenario = {
      ...scenario,
      steps: [{ name: 'early', http: { method: 'GET', path: '/api/v1/things/{{missing.body.id}}' } }],
    };
    const runs = await runScenario(repoRoot, probe, broken);
    const message = 'early: {{missing.body.id}} has no value: no step named "missing" ran before it.';
    expect(runs[0]).toMatchObject({ unresolvedPlaceholder: message, capture: null });
    expect(() => mergeRuns(broken, runs, runs)).toThrow(message);
    const result = compareScenario({ scenario: broken.name, cases: [{ name: 'early', expected: '[..]', noise: ['$'] }] }, runs, broken.name);
    expect(result.cases[0]?.difference).toMatchObject({ path: '$.request', actual: message });
    expect(replayPassed([result], true)).toBe(false);
  });

  test('attributes direct and transitive blocked steps without masking independent mismatches', async () => {
    const replay: Scenario = {
      name: 'with-dependencies',
      description: 'Only marked 501s block dependent cases.',
      steps: [
        { name: 'unported', http: { method: 'POST', path: '/api/v1/app/settings' } },
        { name: 'direct', http: { method: 'GET', path: '/api/v1/things?etag={{unported.headers.etag}}' } },
        { name: 'transitive', http: { method: 'GET', path: '/api/v1/things?item={{direct.body.id}}' } },
        { name: 'ordinary-response', http: { method: 'GET', path: '/api/v1/auth/status' } },
        { name: 'missing-field', http: { method: 'GET', path: '/api/v1/things?item={{ordinary-response.body.missing}}' } },
        { name: 'both', http: { method: 'GET', path: '/api/v1/things?one={{unported.body.id}}&two={{ordinary-response.body.missing}}' } },
      ],
    };
    const runs = await runScenario(repoRoot, { ...probe, command: [...probe.command, '--settings-unported'] }, replay);
    expect(runs.map((run) => run.unavailable ?? null)).toEqual([
      { kind: 'unported' },
      { kind: 'blocked', supplier: 'unported' },
      { kind: 'blocked', supplier: 'direct' },
      null, null, null,
    ]);
    expect(runs.slice(1, 3).map((run) => run.capture)).toEqual([null, null]);
    const result = compareScenario({
      scenario: replay.name,
      cases: replay.steps.map(({ name }) => ({
        name, expected: name === 'ordinary-response' ? runs[3]!.capture : { status: 200 }, noise: [],
      })),
    }, runs, replay.name);
    const report = renderReport('native-probe', [result], true);
    expect(report).toContain('| with-dependencies | 1/6 | 1/6 | 1 | 2 | 2 |');
    expect(report).toContain('- with-dependencies/direct: blocked by unported');
    expect(report).toContain('- with-dependencies/transitive: blocked by direct');
    expect(replaySummary([result], report)).toContain('BLOCKED with-dependencies/transitive by direct');
    expect(result.cases.slice(-2).map((entry) => entry.difference?.path)).toEqual(['$.request', '$.request']);
    expect(replayPassed([result], true)).toBe(false);
    const withoutMismatches = { ...result, cases: result.cases.slice(0, 4) };
    expect(replayPassed([withoutMismatches])).toBe(false);
    expect(replayPassed([withoutMismatches], true)).toBe(true);
  });

  for (const clientRequestId of ['probe-request', undefined]) {
    const request: Json = clientRequestId === undefined ? { type: 'chat-subscribe' } : { type: 'chat-subscribe', clientRequestId };
    const correlation = clientRequestId === undefined ? 'uncorrelated fault' : 'correlated reply';
    test(`classifies a marked WebSocket ${correlation} and blocks its dependent steps`, async () => {
      const replay: Scenario = {
        name: 'socket-dependencies',
        description: 'The native WebSocket reply marks an unported operation.',
        steps: [
          { name: 'socket', ws: { path: '/probe-ws', send: [request], frames: 1 } },
          { name: 'direct', http: { method: 'GET', path: '/api/v1/things/{{socket.body.id}}' } },
          { name: 'transitive', http: { method: 'GET', path: '/api/v1/things/{{direct.body.id}}' } },
          { name: 'status', http: { method: 'GET', path: '/api/v1/auth/status' } },
        ],
      };
      const runs = await runScenario(repoRoot, { ...probe, command: [...probe.command, '--ws-unported'] }, replay);
      expect(runs[0]?.capture).toMatchObject({ opened: true, frames: [{
        type: clientRequestId === undefined ? 'ws-fault' : 'client-request-error', garconRsUnported: true,
      }] });
      expect(runs.map((run) => run.unavailable ?? null)).toEqual([
        { kind: 'unported' }, { kind: 'blocked', supplier: 'socket' }, { kind: 'blocked', supplier: 'direct' }, null,
      ]);
      expect(runs.slice(1, 3).map((run) => run.capture)).toEqual([null, null]);
      const result = compareScenario({ scenario: replay.name, cases: replay.steps.map(({ name }) => ({
        name, expected: name === 'status' ? runs[3]!.capture : { status: 200 }, noise: [],
      })) }, runs, replay.name);
      const report = renderReport('socket-probe', [result], true);
      expect(report).toContain('| socket-dependencies | 1/4 | 1/4 | 1 | 2 | 0 |');
      expect(report).toContain('socket-dependencies/direct: blocked by socket');
      expect(report).toContain('socket-dependencies/transitive: blocked by direct');
      expect(replayPassed([result])).toBe(false);
      expect(replayPassed([result], true)).toBe(true);
    });
  }

  test('compares an unmarked WebSocket error even when unported cases are allowed', async () => {
    const replay: Scenario = {
      name: 'unmarked-socket', description: 'An ordinary error stays a mismatch.',
      steps: [{ name: 'socket', ws: { path: '/probe-ws', send: [{ type: 'chat-subscribe', clientRequestId: 'probe-request' }], frames: 1 } }],
    };
    const runs = await runScenario(repoRoot, probe, replay);
    expect(runs[0]?.unavailable).toBeUndefined();
    const expected = structuredClone(runs[0]!.capture) as { frames: { message: string }[] };
    expected.frames[0]!.message = 'the expected error';
    const golden: Golden = { scenario: replay.name, cases: [{ name: 'socket', expected, noise: [] }] };
    const result = compareScenario(golden, runs, replay.name);
    expect(result.cases[0]?.difference).toMatchObject({ path: '$.frames[0].message', actual: '"not ported"' });
    expect(replayPassed([result], true)).toBe(false);
  });
});
